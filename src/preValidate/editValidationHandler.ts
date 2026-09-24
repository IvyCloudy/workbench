/**
 * ============================================================================
 *  preValidate/editValidationHandler.ts
 *  编辑期主动校验（B3）——「打开 / 编辑」文件时立刻跑一次 pushCore 校验规则，
 *  把结果同步写到 pushFailureStore，让表格视图能实时看到红/黄高亮。
 * ----------------------------------------------------------------------------
 *  从 handlers/editValidationHandler.ts 迁移过来（2026-09-19 解耦），
 *  语义与依赖完全不变。原路径保留为 re-export barrel（@deprecated）。
 *
 *  设计原则：
 *    1. 复用推送期的 DEFAULT_VALIDATORS —— 与 stepPreValidate 使用同一套规则。
 *    2. Y 方案：编辑期校验结果就是当前唯一权威源，覆盖之前的推送失败盘。
 *    3. 防抖：yaml / json 500ms（结构化文档、parse 廉价） / csv 800ms（整表组装稍重）；解析失败静默降级为空清单。
 *    4. 只对合规目录下的 yaml / csv / json 生效（需求 §2.2.1 明确 csv/json/yaml 三类均要参与）。
 *    5. 通过 BaseEditorProvider.postEditValidationRefresh 通知已打开 webview 拉新。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { runValidatorsOnRowsPure } from './validators';
import type { RowLike } from '../handlers/pushCore.types';
import type { PushFailureItem } from '../handlers/pushCore.types';
import { classifyFailure } from '../utils/pushFailure/categoryClassify';
import { persistPushFailures, clearFailures } from '../utils/pushFailureStore';
import { detectFileType, createParser, type FileType } from '../parsers';
import { FILE_PATTERNS, isInQualifiedDir } from '../services/utils';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { TelemetryService } from '../utils/telemetry';
import {
    detectMissingColumns,
    buildMissingColumnReason,
} from './missingColumns';
import { buildCsvRowLikes } from './csvRowAdapter';

// ----------------------------------------------------------------------------
// 防抖配置（依 B3 需求最终定稿：yaml / json 500ms，csv 800ms）
//   · yaml / json 是结构化文档，parse 廉价 → 短防抖，反馈更快
//   · csv 需按 headers + rows 组装成对象，大文件稍重 → 长防抖，避免频繁抖动
//
// P5 · 大文件防抖升级（2026-09-19）：
//   · 文件字节数 > BIG_FILE_BYTES 时，视为大文件 —— parse + validate + persist 单次成本明显
//     偏高（1w 行以上的 CSV/YAML 单次 pipeline 约 200–500ms）。此时用户连续敲键盘会造成
//     "每次编辑都全量重跑"的抖动，因此把防抖档拉到 1500ms，让键盘停顿后再执行一次即可。
//   · 小文件保持原档位（500 / 800ms），反馈快。
//   · size 通过 fs.statSync 拿 —— 单次调用 <1ms，且用 TTL 60s 的短命缓存避免每次编辑重复 IO。
// ----------------------------------------------------------------------------
const DEBOUNCE_MS_YAML = 500;
const DEBOUNCE_MS_CSV = 800;
const DEBOUNCE_MS_BIG = 1500;
/** 大文件阈值（字节）。约对应 CSV 5000+ 行 / YAML 1.5w+ 行的量级。 */
const BIG_FILE_BYTES = 512 * 1024; // 512 KB
/** 文件字节数缓存 TTL（毫秒）。同一文件 60s 内不重复 stat。 */
const SIZE_CACHE_TTL_MS = 60 * 1000;
/** 文件字节数缓存条目上限（软保护）。达到后清最旧的一半，避免长会话下 Map 无限增长。 */
const SIZE_CACHE_MAX = 500;

// filePath -> { size, ts } 短命缓存（避免键盘连击时每次都 stat 磁盘）
const _sizeCache: Map<string, { size: number; ts: number }> = new Map();

function _getFileSizeCached(filePath: string): number {
    const now = Date.now();
    const hit = _sizeCache.get(filePath);
    if (hit && now - hit.ts < SIZE_CACHE_TTL_MS) return hit.size;
    let size = 0;
    try {
        const st = fs.statSync(filePath);
        size = st?.size || 0;
    } catch (_) {
        size = 0;
    }
    // 缓存软保护：条目过多时清理最旧的一半（Map 按插入顺序遍历，靠前即最旧）
    if (_sizeCache.size >= SIZE_CACHE_MAX) {
        const dropCount = Math.floor(SIZE_CACHE_MAX / 2);
        let dropped = 0;
        for (const k of _sizeCache.keys()) {
            if (dropped++ >= dropCount) break;
            _sizeCache.delete(k);
        }
    }
    _sizeCache.set(filePath, { size, ts: now });
    return size;
}

// filePath -> 待执行的 timer；连续编辑时后一个 timer 会取消前一个
const _pendingTimers: Map<string, NodeJS.Timeout> = new Map();

// filePath -> 最近一次 validate 序列号；用于异步竞态时丢弃过期结果
const _seqMap: Map<string, number> = new Map();

// 删除流程（案例文件删除 / 删除结果详情重开编辑器）重开编辑器时，临时抑制
// 「案例格式校验」弹窗——删除按需求不做格式校验，重开仅用于展示删除结果，
// 不应再弹出格式校验窗口。该标志为短时开关：在重开前置 true，重开后置 false。
let _suppressValidationPrompt = false;
export function setSuppressEditValidationPrompt(value: boolean): void {
    _suppressValidationPrompt = value;
}

// 说明：2026-09-19 后策略调整为「仅『打开文件』时弹窗，保存/编辑一律不弹」。
// 因此打开通路每次都强制弹（用户如果没改就再打开，理应再看到提示），无需再做
// 指纹去重。保留常量位仅用于必要时的调试观察，不参与逻辑判断。

/**
 * 识别目标文件类型 + 合规目录：不合规的文件不参与编辑期校验。
 *
 * 支持类型：
 *   · .yaml / .yml → 'yaml'
 *   · .csv         → 'csv'
 *   · .json        → 'json'（2026-09-19 补齐 P1：需求 §2.2.1 / §3 明确 csv/json/yaml 三类均要参与）
 * 三类文件均要求位于「测试任务/<任务>/测试案例/」合规目录内，且不在「临时文件」文件夹下。
 */
function resolveTargetType(filePath: string): FileType | null {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
        return isInQualifiedDir(filePath, FILE_PATTERNS.YAML) ? 'yaml' : null;
    }
    if (lower.endsWith('.csv')) {
        return isInQualifiedDir(filePath, FILE_PATTERNS.CSV) ? 'csv' : null;
    }
    if (lower.endsWith('.json')) {
        return isInQualifiedDir(filePath, FILE_PATTERNS.JSON) ? 'json' : null;
    }
    return null;
}

/**
 * 真正的校验执行体：parse → 跑规则 → 覆盖式写盘 → 通知 webview 刷新。
 *
 * @param filePath        目标文件绝对路径
 * @param promptOnMissing 是否在"打开文件"通路弹窗。
 *                        · true  → 由"打开文件"通路（TextEditor / CustomEditor 首次打开）驱动，
 *                                  按需求 §2.2.1 / §2.3.5 弹窗，合并"文件级（缺列）+ 行级
 *                                  （枚举非法 / 待补充 / 名称空 / 计划执行次数非法 …）"所有问题
 *                                  一次性展示；
 *                        · false → 由"保存 / 编辑防抖"通路驱动，仅静默跑校验、刷新高亮，
 *                                  不打断用户手上的动作（对齐用户诉求：
 *                                  「只需要在文件打开时弹窗，推送前校验包含该项，文件修改保存无需触发」）。
 *                        无论 true/false，结构性检测本身都会跑（用于给行级高亮/持久化提供数据基础，
 *                        以及给推送前 stepPreValidate 共用同一份判定）。
 */
/**
 * 单次编辑期校验结论（结构化）：
 *   · aborted     —— 被竞态 / 持久化异常中断，结果不可信，调用方不应据此弹"通过"；
 *   · hasFailures —— 是否存在问题（文件级缺列 + 行级失败任一存在）；
 *   · counts      —— 按 category 聚合的问题个数（含文件级 'missingColumn' 与行级各类）。
 */
export interface EditValidationResult {
    aborted: boolean;
    hasFailures: boolean;
    counts: Record<string, number>;
}
async function _doValidate(filePath: string, promptOnMissing: boolean = false): Promise<EditValidationResult> {
    const seq = (_seqMap.get(filePath) || 0) + 1;
    _seqMap.set(filePath, seq);

    const fileType = detectFileType(filePath);
    if (!fileType) return { aborted: true, hasFailures: false, counts: {} };

    const parser = createParser(fileType);
    let sourceRows: RowLike[] = [];
    let parsedHeaders: string[] | undefined;
    let parsedSourceData: any;
    try {
        const parsed = await parser.parse(filePath);
        parsedHeaders = parsed?.tableData?.headers;
        parsedSourceData = parsed?.sourceData;
        const src = parsed.sourceData;

        if (fileType === 'csv') {
            // 修复（2026-09-19）：CSV parser 的 sourceData 恒为 null（见 csv-parser.ts），
            // 若继续走"src 为空 → sourceRows=[]"分支，会导致 CSV 文件从来不跑行级校验
            // （现象：单元格「功能点类111」这种非法枚举值不会飘红、编辑期弹窗不触发）。
            // P4 · 抽公共 buildCsvRowLikes 以便与 batchPreValidate 共享一份实现，避免行数据组装
            // 逻辑双份维护、任一处修复漏另一处。
            sourceRows = buildCsvRowLikes(parsedHeaders, parsed?.tableData?.rows);
        } else if (Array.isArray(src)) {
            sourceRows = src as RowLike[];
        } else if (src && typeof src === 'object') {
            sourceRows = [src as RowLike];
        } else {
            sourceRows = [];
        }
    } catch (_err) {
        sourceRows = [];
    }

    // §2.3.5 · 结构性检查（缺列）预计算：先算出文件级 failures，但不立即弹窗。
    //   · 保存 / 编辑防抖通路（promptOnMissing=false）也会跑本段检测，用于让行级校验
    //     和推送前拦截拿到最新数据，但**不弹窗**，避免打断用户手上的动作。
    //   · 打开通路（promptOnMissing=true）会把结构性 failures 与行级 failures 合并后
    //     一次性弹一个 05g 弹窗，避免用户先看到缺列弹窗、再看到行级 refresh，两次打断。
    let fileLevelFailures: PushFailureItem[] = [];
    let missingLabelsForTelemetry: string[] = [];
    if (parsedHeaders !== undefined || parsedSourceData !== undefined) {
        const missingResult = detectMissingColumns(fileType, parsedHeaders, parsedSourceData);
        if (!missingResult.ok && missingResult.missing.length > 0) {
            // 组装文件级 failures —— 与 stepPreValidate 中的推送前拦截结构完全一致：
            //   · tsId='__FILE_LEVEL__' 让 05g 分组到同一张卡片（不按行拆散）；
            //   · rowIndex 留空 → 前端走文件级渲染分支（不显示"第 N 行"）；
            //   · reason 由 buildMissingColumnReason(hit, fileType) 组装
            //     （YAML 带英文键 `xxx（对应 YAML 字段：xxx）`；CSV 纯中文）。
            fileLevelFailures = missingResult.missing.map(hit => {
                const reason = buildMissingColumnReason(hit, fileType);
                return {
                    tsId: '__FILE_LEVEL__',
                    reason,
                    category: classifyFailure({ reason, validatorKind: 'missingColumn' }),
                    severity: 'error' as const,
                } as PushFailureItem;
            });
            missingLabelsForTelemetry = missingResult.missing.map(m => m.label);
        }
    }

    // 异步竞态保护：慢 parse 已被后续 fast parse 覆盖，不再写盘
    if (_seqMap.get(filePath) !== seq) return { aborted: true, hasFailures: false, counts: {} };

    // 编辑期视图：源数据的 1-based 索引即行号（parse 后已按文件顺序）
    const failures = runValidatorsOnRowsPure(sourceRows, i => i + 1);

    // §2.3.5 · 打开文件通路：把文件级（缺列）+ 行级（枚举/待补充/名称空/计划执行次数等）合并成
    //   一份 failures 一次弹出，与推送前拦截共用同一个 05g 弹窗（openPreValidateGate）。
    //   顺序：文件级置顶（tsId='__FILE_LEVEL__'）→ 行级按行号；前端渲染时天然按此顺序显示。
    if (promptOnMissing && !_suppressValidationPrompt && (fileLevelFailures.length > 0 || failures.length > 0)) {
        const combined: PushFailureItem[] = [
            ...fileLevelFailures,
            ...failures.map(f => ({
                tsId: f.tsId,
                reason: f.reason,
                category: f.category,
                field: f.field,
                severity: f.severity,
                rowIndex: f.rowIndex,
                stepIdx: f.stepIdx,
                subField: f.subField,
                hits: f.hits,
            } as PushFailureItem)),
        ];
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        void BaseEditorProvider.postFileLevelPreValidateGate(filePath, fileName, combined)
            .catch(err => {
                console.warn('[EditValidation] 打开弹窗失败:', err?.message || err);
            });
        if (fileLevelFailures.length > 0) {
            TelemetryService.sendTelemetryEvent('editValidation.missingColumnsDetected', {
                fileFormat: fileType,
                missingCount: String(fileLevelFailures.length),
                missingLabels: missingLabelsForTelemetry.join('|'),
                trigger: 'open',
            });
        }
        if (failures.length > 0) {
            const openErr = failures.filter(f => f.severity !== 'warn').length;
            const openWarn = failures.length - openErr;
            TelemetryService.sendTelemetryEvent('editValidation.openPromptFailures', {
                fileFormat: fileType,
                errorCount: String(openErr),
                warnCount: String(openWarn),
                fileLevelCount: String(fileLevelFailures.length),
            });
        }
    }

    try {
        if (failures.length === 0) {
            await clearFailures(filePath);
        } else {
            await persistPushFailures(
                filePath,
                sourceRows as any[],
                failures.map(f => ({
                    tsId: f.tsId,
                    reason: f.reason,
                    category: f.category,
                    field: f.field,
                    severity: f.severity,
                    // B4：透传 stepIdx/subField/hits，供前端展开态 sub-td / dv2 弹窗精确高亮。
                    stepIdx: f.stepIdx,
                    subField: f.subField,
                    hits: f.hits,
                })),
                [],
            );
        }
    } catch (err: any) {
        console.warn('[EditValidation] 持久化失败盘失败:', err?.message || err);
        return { aborted: true, hasFailures: false, counts: {} };
    }

    // 通知已打开的 webview：让它拉一次新的失败盘并重绘
    try {
        BaseEditorProvider.postEditValidationRefresh(filePath);
    } catch (_) { /* ignore */ }

    // 埋点（低频）：只在有失败时上报一次
    if (failures.length > 0) {
        const errorCount = failures.filter(f => f.severity !== 'warn').length;
        const warnCount = failures.length - errorCount;
        TelemetryService.sendTelemetryEvent('editValidation.failuresDetected', {
            fileFormat: fileType,
            errorCount: String(errorCount),
            warnCount: String(warnCount),
        });
    }

    // 返回本次校验结论（结构化）：aborted=被竞态/持久化异常中断；
    // hasFailures=文件级缺列或行级失败任一存在；counts=按 category 聚合的问题个数。
    const allFailures = [...fileLevelFailures, ...failures];
    const counts: Record<string, number> = {};
    for (const f of allFailures) {
        const c = f.category || 'unknown';
        counts[c] = (counts[c] || 0) + 1;
    }
    return { aborted: false, hasFailures: allFailures.length > 0, counts };
}

/**
 * 请求一次编辑期校验（外部驱动入口，含防抖）。
 *
 * @param opts.immediate         为 true 时跳过防抖立即执行（打开 / 保存 / webview 挂载均用此路径）。
 * @param opts.promptOnMissing   为 true 时"打开文件"通路会弹 05g 弹窗，
 *                               合并「文件级缺列 + 行级枚举非法/待补充/名称空/计划执行次数非法…」
 *                               一次性展示；仅"打开文件"通路应传 true。
 *                               保存 / 编辑防抖通路默认 false —— 只静默跑校验、不弹窗，
 *                               对齐用户诉求「文件修改保存无需触发弹窗」。
 * @returns Promise<EditValidationResult | undefined>
 *                               · 正常完成返回结构化结论（aborted=false，含 hasFailures / counts）；
 *                               · immediate=false（防抖通路）或异常时返回 undefined，仅登记 timer / 不消费结果。
 */
export function requestEditValidation(
    filePath: string,
    opts?: { immediate?: boolean; promptOnMissing?: boolean },
): Promise<EditValidationResult | undefined> {
    if (!filePath) return Promise.resolve(undefined);
    const type = resolveTargetType(filePath);
    if (!type) return Promise.resolve(undefined);

    const existing = _pendingTimers.get(filePath);
    if (existing) {
        clearTimeout(existing);
        _pendingTimers.delete(filePath);
    }

    const promptOnMissing = !!opts?.promptOnMissing;

    if (opts?.immediate) {
        return _doValidate(filePath, promptOnMissing).catch(err => {
            console.warn('[EditValidation] immediate validate 异常:', err?.message || err);
            return undefined;
        });
    }

    // 防抖档位分流：
    //   · yaml / json 是结构化文档（顶层键=字段名，parse 廉价），走 500ms 快档；
    //   · csv 需要走整表 headers+rows 组装（大文件下更重），走 800ms 稳档；
    //   · P5 · 文件字节 > BIG_FILE_BYTES（约 512 KB，对应 CSV 5000+ 行 / YAML 1.5w+ 行）
    //     统一升级为 1500ms 大文件档 —— 单次 pipeline 成本高，靠更长防抖窗口降低"敲键盘时
    //     每次都跑一遍全量校验"的抖动感。停顿后仍能及时刷新高亮，体验不劣化。
    let debounce: number;
    if (_getFileSizeCached(filePath) > BIG_FILE_BYTES) {
        debounce = DEBOUNCE_MS_BIG;
    } else if (type === 'yaml' || type === 'json') {
        debounce = DEBOUNCE_MS_YAML;
    } else {
        debounce = DEBOUNCE_MS_CSV;
    }
    const timer = setTimeout(() => {
        _pendingTimers.delete(filePath);
        // 防抖通路（用户正在编辑）永远不弹窗 —— 仅刷新行级高亮 / 失败盘。
        void _doValidate(filePath, false).catch(err => {
            console.warn('[EditValidation] debounced validate 异常:', err?.message || err);
        });
    }, debounce);
    _pendingTimers.set(filePath, timer);
    // 防抖通路不返回具体结果，仅登记 timer；调用方据此得到 undefined。
    return Promise.resolve(undefined);
}

/**
 * activate 时调用：注册文档打开 / 变更 / 保存监听。
 *
 * 弹窗策略（对齐用户诉求「只在文件打开时弹窗」）：
 *   · onDidOpenTextDocument         → 打开 TextEditor 视图，弹窗 ✅
 *   · triggerEditValidationOnWebviewOpen → 打开 CustomEditor 视图，弹窗 ✅
 *   · onDidSaveTextDocument         → 保存，不弹窗 ❌（仍立即跑校验刷新高亮）
 *   · onDidChangeTextDocument       → 编辑防抖，不弹窗 ❌
 */
export function registerEditValidation(): vscode.Disposable[] {
    const subs: vscode.Disposable[] = [];

    subs.push(vscode.workspace.onDidChangeTextDocument(e => {
        const fp = e.document?.uri?.fsPath;
        if (!fp) return;
        // 编辑期：走防抖 + 不弹窗
        requestEditValidation(fp);
    }));

    subs.push(vscode.workspace.onDidSaveTextDocument(doc => {
        const fp = doc?.uri?.fsPath;
        if (!fp) return;
        // 保存：立即跑校验（同步高亮），但不弹窗 —— promptOnMissing 显式为 false
        requestEditValidation(fp, { immediate: true, promptOnMissing: false });
    }));

    subs.push(vscode.workspace.onDidOpenTextDocument(doc => {
        const fp = doc?.uri?.fsPath;
        if (!fp) return;
        // 打开：立即跑 + 弹窗
        requestEditValidation(fp, { immediate: true, promptOnMissing: true });
    }));

    return subs;
}

/**
 * BaseEditorProvider 打开 webview（CustomEditor）时调用：
 * 确保该文件"打开即刻校验一次" + 弹结构性缺列窗（如有）。
 *
 * 返回值为 Promise<void>：调用方仅 await 等待「校验 + 写盘 + refresh」全部完成，
 * 让 webview 首帧 init 之后必然带上最新的 pushFailures 用于红/黄单元格上色，
 * 避免出现「打开文件后瞬间还看不到高亮，稍后才染色」的抖动体验。
 */
export function triggerEditValidationOnWebviewOpen(filePath: string): Promise<void> {
    // 结果由内部消费（决定是否弹窗），对外只保证"校验+写盘+refresh 已完成"
    return requestEditValidation(filePath, { immediate: true, promptOnMissing: true }).then(() => undefined);
}
