/**
 * ============================================================================
 *  utils/telemetry.ts
 *  轻量埋点封装（单例服务化）
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 通过 TelemetryService 单例统一对外暴露 sendTelemetryEvent /
 *       sendTelemetryErrorEvent / sendTelemetryException / trackTiming / flush 方法
 *    2. 自动注入通用上下文（插件版本、VSCode 版本、平台、机器ID、会话ID）
 *    3. 严格遵循 vscode.env.isTelemetryEnabled —— 用户关闭遥测时全部静默丢弃
 *    4. 失败容错：埋点不影响主流程，永远不向上抛错
 *    5. 队列 + 节流批量上报，避免高频事件压垮网关
 *    6. 关闭/激活生命周期事件自动埋点
 *
 *  使用方式：
 *      import { TelemetryService } from '../utils/telemetry';
 *      TelemetryService.sendTelemetryEvent('editor.opened', { targetFile: 'xxx' });
 *      TelemetryService.sendTelemetryErrorEvent('push.failed', { errorMessage: 'xx' });
 *
 *  设计要点：
 *    - 上报通道：优先使用 telemetryUrl，未配置则回退 apiUrl；最终请求 `${base}/api/v1/track`
 *    - 鉴权：Header `X-Telemetry-Token`，对应网关侧 TELEMETRY_TOKENS 之一
 *    - Token 优先级：cfg.telemetryToken（登录后端下发，可灰度/吊销） >  内置 BUILTIN_TELEMETRY_TOKEN（兜底，零配置可用）
 *    - 开发环境（NODE_ENV=development 或 base 为空）默认仅 console.log，不真实上报
 *    - 所有路径/文件名相关字段必须由调用方自行脱敏（hash 或仅传扩展名/大小）
 *    - 单事件 payload 不超过 8KB，超过将被截断
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import { readConfig } from '../services/storage';
import { stackHead } from '../services/utils';

// ============================================
// 内置兜底 Token
// ----------------------------------------------------------------------------
//  * 用户无需任何配置即可让埋点跑通，避免登录前/未配置时数据全部丢失。
//  * 该 Token 必须同步加入网关侧 TELEMETRY_TOKENS 白名单。
//  * 如需吊销老版本插件流量，把该 Token 从网关白名单移除即可（不需要发版）。
//  * 如果用户的 app-config.json 里配置了 telemetryToken（未来由登录接口下发），
//    将优先使用配置值，便于灰度切换。
// ============================================
const BUILTIN_TELEMETRY_TOKEN = 'wb-telemetry-2026-221ae433c3920433044f65e0ee0bde03';

// ============================================
// 类型
// ============================================

/** 事件属性（维度，便于聚合），所有 value 必须为 string */
export type TelemetryEventProperties = Record<string, string | undefined>;
/** 事件度量（用于求和/平均），所有 value 必须为 number */
export type TelemetryEventMeasurements = Record<string, number | undefined>;

export interface StringGenerateProperties {
    [key: string]: string;
}

interface TelemetryEvent {
    /** 事件名，建议 namespace.action 形式，如 push.success */
    name: string;
    /** 维度属性 */
    properties?: TelemetryEventProperties;
    /** 数值度量 */
    measurements?: TelemetryEventMeasurements;
    /** 事件级别 */
    level?: 'info' | 'warn' | 'error';
    /** 事件发生的客户端时间戳（毫秒） */
    ts: number;
}

// ============================================
// 常量
// ============================================
const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH = 20;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_QUEUE = 200;

// ============================================
// 单例实现类（对外通过 TelemetryService 常量访问）
// ============================================
class TelemetryServiceImpl {
    private static _instance: TelemetryServiceImpl | null = null;

    private _context: vscode.ExtensionContext | undefined;
    private _sessionId = '';
    private _commonProps: TelemetryEventProperties = {};
    private _queue: TelemetryEvent[] = [];
    private _flushTimer: NodeJS.Timeout | undefined;
    /** 上一次连续失败次数，用于退避 */
    private _failureCount = 0;
    /** 首次真实上报打印目的端标记 */
    private _targetLogged = false;

    private constructor() { /* singleton */ }

    /** 单例访问入口（内部用） */
    static getInstance(): TelemetryServiceImpl {
        if (!this._instance) this._instance = new TelemetryServiceImpl();
        return this._instance;
    }

    // ========== 生命周期 ==========

    /**
     * 初始化埋点。应在 extension activate 中尽早调用一次。
     * 幂等：多次调用不会重复注册 hook（后续调用只更新 context/sessionId）。
     */
    async init(context: vscode.ExtensionContext): Promise<void> {
        this._context = context;
        this._sessionId = this.genSessionId();

        const pkg = (context.extension && context.extension.packageJSON) || {};
        this._commonProps = {
            extName: pkg.name || 'unknown',
            extVersion: pkg.version || '0.0.0',
            vscodeVersion: vscode.version,
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            osRelease: os.release(),
            language: vscode.env.language,
            machineId: vscode.env.machineId, // VSCode 提供的稳定脱敏 ID
            sessionId: this._sessionId,
        };

        // 监听用户遥测开关变化
        if (vscode.env.onDidChangeTelemetryEnabled) {
            context.subscriptions.push(
                vscode.env.onDidChangeTelemetryEnabled(enabled => {
                    console.log('[telemetry] user toggle telemetry =', enabled);
                    if (!enabled) this._queue = [];
                })
            );
        }

        // 注册激活事件 + 注销 hook
        this.sendTelemetryEvent('extension.activated');
        context.subscriptions.push({
            dispose: () => {
                this.sendTelemetryEvent('extension.deactivated');
                // 尽力一次性 flush
                const remaining = this._queue.splice(0, this._queue.length);
                if (remaining.length) this.postBatch(remaining).catch(() => { /* ignore */ });
            }
        });
    }

    // ========== 对外埋点方法（单例实例方法） ==========

    /** 上报一个普通事件 */
    sendTelemetryEvent(eventName: string, props?: StringGenerateProperties): void {
        this.internalSend(eventName, 'info', props);
    }

    /** 上报一个错误事件（业务可预期错误，例如接口返回失败） */
    sendTelemetryErrorEvent(eventName: string, props?: StringGenerateProperties): void {
        this.internalSend(eventName, 'error', props);
    }

    /** 上报一个异常事件（内部自动提取 errorMessage + stackHead 到 properties） */
    sendTelemetryException(eventName: string, props?: StringGenerateProperties): void {
        this.internalSend(eventName, 'error', props);
    }

    /**
     * 包裹一段异步逻辑，自动上报耗时与成功/失败结果。
     * 用法：
     *   await TelemetryService.trackTiming('push.flow', async () => { ... }, { totalRows: 100 });
     */
    async trackTiming<T>(
        eventName: string,
        fn: () => Promise<T>,
        properties?: TelemetryEventProperties,
    ): Promise<T> {
        const start = Date.now();
        try {
            const ret = await fn();
            this.internalSendFull(eventName, 'info',
                { ...properties, execResult: 'success' },
                { costMs: Date.now() - start });
            return ret;
        } catch (err: any) {
            this.sendTelemetryException(eventName, {
                ...(properties as StringGenerateProperties),
                execResult: 'error',
                errorMessage: String(err?.message || String(err)).slice(0, 500),
                stackHead: stackHead(err),
            });
            // 仍然抛出，由调用方决定如何处理
            throw err;
        }
    }

    /** 仅供测试/特殊场景：立即清空队列上报 */
    async flush(): Promise<void> {
        if (!this.isEnabled()) return;
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = undefined;
        }
        const batch = this._queue.splice(0, this._queue.length);
        if (batch.length) await this.postBatch(batch);
    }

    // ========== 内部实现 ==========

    private isEnabled(): boolean {
        // VSCode 用户级遥测开关（最高优先级）
        if (typeof vscode.env.isTelemetryEnabled === 'boolean' && !vscode.env.isTelemetryEnabled) {
            return false;
        }
        return !!this._context;
    }

    /** 仅本地打印、不真实上报的开发模式判断
     *
     *  规则（2026-05 调整）：
     *    - NODE_ENV=development              → dev 静默
     *    - 没拿到任何上报地址（空字符串）   → dev 静默
     *    - 其他情况（包括显式配置的 127.0.0.1 / localhost）→ 真实上报
     *
     *  这样既能在生产侧避免「用户没配 telemetryUrl 就把数据打到本机」的乌龙，
     *  也允许开发者通过 app-config.json 显式配 http://127.0.0.1:8080 联调本地网关。
     */
    private isDevMode(apiUrl: string): boolean {
        if (process.env.NODE_ENV === 'development') return true;
        if (!apiUrl) return true;
        return false;
    }

    private safeStringify(obj: any): string {
        try {
            const str = JSON.stringify(obj);
            if (str.length > MAX_PAYLOAD_BYTES) {
                return str.slice(0, MAX_PAYLOAD_BYTES) + '...[truncated]';
            }
            return str;
        } catch {
            return '"[unserializable]"';
        }
    }

    private genSessionId(): string {
        return crypto.randomBytes(8).toString('hex');
    }

    /** 简单事件入队：level=info/error，仅带 properties（对应外部 4 个 send* 方法） */
    private internalSend(
        eventName: string,
        level: 'info' | 'warn' | 'error',
        properties?: TelemetryEventProperties,
    ): void {
        if (!this.isEnabled()) return;
        this.enqueue({ name: eventName, properties, level, ts: Date.now() });
    }

    /** 完整事件入队：支持 measurements（trackTiming 用） */
    private internalSendFull(
        eventName: string,
        level: 'info' | 'warn' | 'error',
        properties?: TelemetryEventProperties,
        measurements?: TelemetryEventMeasurements,
    ): void {
        if (!this.isEnabled()) return;
        this.enqueue({ name: eventName, properties, measurements, level, ts: Date.now() });
    }

    private enqueue(ev: TelemetryEvent): void {
        if (!this.isEnabled()) return;
        if (this._queue.length >= MAX_QUEUE) {
            // 丢弃最早的事件，保护内存
            this._queue.splice(0, this._queue.length - MAX_QUEUE + 1);
        }
        this._queue.push(ev);
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this._flushTimer) return;
        // 简单退避：连续失败超过 3 次后，把间隔拉长到 30s
        const delay = this._failureCount >= 3 ? 30_000 : FLUSH_INTERVAL_MS;
        this._flushTimer = setTimeout(() => {
            this._flushTimer = undefined;
            const batch = this._queue.splice(0, MAX_BATCH);
            if (batch.length === 0) return;
            // 不 await，避免阻塞后续 push
            this.postBatch(batch).catch(() => { /* 已在 postBatch 内处理 */ });
            if (this._queue.length > 0) this.scheduleFlush();
        }, delay);
    }

    private async postBatch(events: TelemetryEvent[]): Promise<void> {
        if (!this._context || events.length === 0) return;
        const cfg = await readConfig(this._context);
        // 埋点网关：优先 telemetryUrl，留空回退到 apiUrl（兼容旧部署）
        const telemetryBase = ((cfg.telemetryUrl || cfg.apiUrl) || '').trim().replace(/\/+$/, '');
        // Token 优先级：用户配置（含登录后端下发） > 内置兜底
        // 这样未来一旦后端在登录响应里下发 telemetryToken，会自动覆盖兜底值，无需发版。
        const telemetryToken = ((cfg.telemetryToken || '').trim() || BUILTIN_TELEMETRY_TOKEN).trim();

        const payload = {
            sessionId: this._sessionId,
            common: this._commonProps,
            events,
        };

        // 开发环境：仅 console（用 telemetryBase 判断，未配置网关时也按 dev 处理）
        if (this.isDevMode(telemetryBase)) {
            console.log('[telemetry][dev] batch=', events.length, this.safeStringify(payload));
            return;
        }

        // 理论上有兜底 Token 不会触发，但保留防御
        if (!telemetryToken) {
            console.warn('[telemetry] 未配置 telemetryToken 且无内置兜底，事件已丢弃');
            return;
        }

        // 首次真实上报时打印目的端，便于排查本地联调
        if (!this._targetLogged) {
            this._targetLogged = true;
            console.log('[telemetry] target =', telemetryBase + '/api/v1/track',
                'tokenSource =', (cfg.telemetryToken || '').trim() ? 'config' : 'builtin');
        }

        // 生产：POST 到 telemetry 网关；失败不影响业务，只记录日志
        try {
            const url = `${telemetryBase}/api/v1/track`;
            const body = JSON.stringify(payload);
            await new Promise<void>((resolve, reject) => {
                try {
                    const httpMod = url.startsWith('https') ? require('https') : require('http');
                    const u = new URL(url);
                    const req = httpMod.request({
                        hostname: u.hostname,
                        port: u.port || (u.protocol === 'https:' ? 443 : 80),
                        path: u.pathname + u.search,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(body, 'utf8'),
                            'X-Telemetry-Token': telemetryToken,
                        },
                    }, (res: any) => {
                        res.on('data', () => { /* drain */ });
                        res.on('end', () => {
                            // 非 2xx 视为失败，纳入退避
                            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                                resolve();
                            } else {
                                reject(new Error(`telemetry http ${res.statusCode}`));
                            }
                        });
                    });
                    req.on('error', (e: any) => reject(e));
                    req.setTimeout(5000, () => { req.destroy(); reject(new Error('telemetry timeout')); });
                    req.write(body);
                    req.end();
                } catch (e) {
                    reject(e);
                }
            });
            this._failureCount = 0;
        } catch (err: any) {
            this._failureCount++;
            console.warn('[telemetry] 上报失败（已忽略）:', err?.message || err);
        }
    }
}

// ============================================
// 对外单例（其他模块的唯一使用入口）
// ============================================

/**
 * 埋点单例服务。所有模块应通过它调用埋点：
 *   TelemetryService.sendTelemetryEvent('editor.opened', { targetFile });
 *   TelemetryService.sendTelemetryErrorEvent('push.failed', { errorMessage });
 */
export const TelemetryService = TelemetryServiceImpl.getInstance();
