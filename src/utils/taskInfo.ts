/**
 * ============================================================================
 *  utils/taskInfo.ts
 *  ⭐ 测试任务信息（含真实后端字段）的统一业务入口
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 提供 getTaskInfoByFilePath：基于文件全路径返回任务信息。
 *       - 路径解析失败 / 未在绑定文件中配置 / 阶段未配置 → bind=false, taskInfo={}
 *       - 全部齐备 → bind=true, taskInfo 6 字段都有值
 *    2. 提供 extractTestPhaseName：从 CSV/YAML/JSON 文件内容中读取
 *       testPhaseName（与原 TestCaseProvider.ParamExtractor 行为一致）。
 *  设计要点：
 *    - testTaskNo / subTestTaskName 仅作为定位 key 用，真实下发字段以
 *      task-bindings.json 中绑定为准（后端值可能与目录名不同）。
 *    - 本模块不依赖 vscode 之外的运行时上下文，仅依赖 ExtensionContext 用于
 *      访问 globalStorage。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveTaskInfo, FILE_PATTERNS } from '../services/utils';
import { lookupBinding } from './taskInfoStore';

// ============================================
// 类型定义
// ============================================

/** 完整的测试任务信息（与 task-bindings.json 中字段对齐 + testPhaseName） */
export interface FullTaskInfo {
    /** 测试任务编号（后端真实值） */
    testTaskNo: string;
    /** 测试任务名称 */
    testTaskName: string;
    /** 子测试任务 ID */
    subTestTaskId: number;
    /** 子测试任务名称 */
    subTestTaskName: string;
    /** 测试阶段名称（来源于文件内容） */
    testPhaseName: string;
    /** 阶段 ID（与 testPhaseName 配套） */
    phaseId: number;
}

export interface GetTaskInfoResult {
    /** 是否成功绑定到真实后端任务信息 */
    bind: boolean;
    /**
     * 当 bind=true 时为完整字段；
     * 当 bind=false 时为空对象 {}（按需求约定）。
     */
    taskInfo: FullTaskInfo | Record<string, never>;
}

// ============================================
// 公共：根据文件路径获取任务信息
// ============================================

/**
 * 根据文件全路径获取完整的测试任务信息。
 *
 * 流程：
 *   1. 用 resolveTaskInfo 解析路径（拿到 testTaskNo + subTestTaskName）
 *   2. 拼出绑定 key：<项目目录名>/测试任务/<testTaskNo>_<subTestTaskName>
 *   3. 在 task-bindings.json 中查找对应记录
 *   4. 从文件内容提取 testPhaseName
 *   5. 在 binding.phaseBindings[testPhaseName] 中查 phaseId
 *   6. 全部齐备返回 bind=true，否则 bind=false
 */
export async function getTaskInfoByFilePath(
    context: vscode.ExtensionContext,
    filePath: string
): Promise<GetTaskInfoResult> {
    if (!filePath) return { bind: false, taskInfo: {} };

    // Step1: 路径解析
    const r = resolveTaskInfo(filePath);
    if (!r.ok) return { bind: false, taskInfo: {} };

    // Step2: 拼 key
    const key = buildBindingKey(filePath, r.info.testTaskNo, r.info.subTestTaskName);
    if (!key) return { bind: false, taskInfo: {} };

    // Step3: 查找绑定
    const entry = lookupBinding(context, key);
    if (!entry) return { bind: false, taskInfo: {} };

    // Step4: 提取 testPhaseName
    const testPhaseName = await extractTestPhaseName(filePath);
    if (!testPhaseName) return { bind: false, taskInfo: {} };

    // Step5: 阶段绑定
    const phaseBinding = entry.phaseBindings && entry.phaseBindings[testPhaseName];
    if (!phaseBinding || phaseBinding.phaseId == null) {
        return { bind: false, taskInfo: {} };
    }

    // Step6: 各字段齐备校验
    if (!entry.testTaskNo || !entry.testTaskName ||
        entry.subTestTaskId == null || !entry.subTestTaskName) {
        return { bind: false, taskInfo: {} };
    }

    return {
        bind: true,
        taskInfo: {
            testTaskNo: entry.testTaskNo,
            testTaskName: entry.testTaskName,
            subTestTaskId: entry.subTestTaskId,
            subTestTaskName: entry.subTestTaskName,
            testPhaseName,
            phaseId: phaseBinding.phaseId,
        },
    };
}

// ============================================
// 公共：根据文件路径获取「表头展示」用任务信息
// ============================================

/** 表头三项展示信息：均为字符串，未命中时为空串。 */
export interface HeaderTaskInfo {
    /** 是否在 task-bindings.json 中命中绑定（用于第一行最左侧的状态标签） */
    bind: boolean;
    /** 测试任务编号（来自 task-bindings.json，命中绑定时为后端真实值） */
    testTaskNo: string;
    /** 测试任务名称（来自 task-bindings.json） */
    testTaskName: string;
    /** 子测试任务名称（来自 task-bindings.json） */
    subTestTaskName: string;
}

/**
 * 仅供 webview 表头使用：只关心「任务身份」，不要求 testPhaseName/phaseId。
 *
 * 命中规则：
 *   - 路径解析出 testTaskNo + subTestTaskName，并能拼出绑定 key
 *   - task-bindings.json 中存在该 key
 *   命中 → 返回绑定文件中的 testTaskNo / testTaskName / subTestTaskName
 *   未命中 → 三项均返回空串（UI 层会渲染为占位符 "-"）
 *
 * 与 getTaskInfoByFilePath 的区别：
 *   - getTaskInfoByFilePath：业务用，必须 6 字段 + phaseId 全齐才算 bind=true
 *   - getHeaderTaskInfoByFilePath：仅用于表头展示，绑定命中即可
 */
export function getHeaderTaskInfoByFilePath(
    context: vscode.ExtensionContext,
    filePath: string
): HeaderTaskInfo {
    const empty: HeaderTaskInfo = { bind: false, testTaskNo: '', testTaskName: '', subTestTaskName: '' };
    if (!filePath) return empty;

    const r = resolveTaskInfo(filePath);
    if (!r.ok) return empty;

    const key = buildBindingKey(filePath, r.info.testTaskNo, r.info.subTestTaskName);
    if (!key) return empty;

    const entry = lookupBinding(context, key);
    if (!entry) return empty;

    return {
        bind: true,
        testTaskNo: entry.testTaskNo || '',
        testTaskName: entry.testTaskName || '',
        subTestTaskName: entry.subTestTaskName || '',
    };
}

// ============================================
// 内部：构造绑定 key
// ============================================

/**
 * 从文件路径提取「项目目录名/测试任务/<TTxxx_子任务名>」作为绑定 key。
 * 项目目录名 = "测试任务" 父级目录名。
 */
function buildBindingKey(filePath: string, testTaskNo: string, subTestTaskName: string): string {
    if (!testTaskNo || !subTestTaskName) return '';
    const parts = filePath.split(path.sep);
    const idx = parts.indexOf('测试任务');
    if (idx <= 0) return '';
    const projectDir = parts[idx - 1];
    if (!projectDir) return '';
    return `${projectDir}/测试任务/${testTaskNo}_${subTestTaskName}`;
}

// ============================================
// 公共：从文件内容提取 testPhaseName
// ============================================

/**
 * 从 CSV / YAML / JSON 文件内容中提取 testPhaseName。
 * 行为与原 TestCaseProvider.ParamExtractor 完全一致，仅迁移位置。
 */
export async function extractTestPhaseName(filePath: string): Promise<string> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        if (FILE_PATTERNS.CSV.test(filePath)) return fromCsv(content);
        if (FILE_PATTERNS.YAML.test(filePath)) return fromYaml(content);
        if (FILE_PATTERNS.JSON.test(filePath)) return fromJson(content);
    } catch {
        // fall through
    }
    return '';
}

function fromCsv(content: string): string {
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return '';
    const headers = parseCsvLine(lines[0]);
    const data = parseCsvLine(lines[1]);
    const idx = headers.findIndex(h => h.trim().toLowerCase() === 'testphasename');
    return idx >= 0 ? (data[idx] || '').trim() : '';
}

function fromYaml(content: string): string {
    try {
        const YAML = require('yaml');
        const parsed = YAML.parse(content);
        const records = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        return records.length > 0 ? searchKey(records[0], 'testPhaseName') : '';
    } catch {
        return '';
    }
}

function fromJson(content: string): string {
    try {
        const parsed = JSON.parse(content);
        const records = Array.isArray(parsed) ? parsed : [parsed];
        return records.length > 0 ? searchKey(records[0], 'testPhaseName') : '';
    } catch {
        return '';
    }
}

/** 在对象中递归查找指定 key（大小写不敏感），返回首个匹配字符串值 */
function searchKey(obj: any, target: string): string {
    if (!obj || typeof obj !== 'object') return '';
    const lowerKey = target.toLowerCase();
    for (const k of Object.keys(obj)) {
        if (k.toLowerCase() === lowerKey) return String(obj[k] ?? '').trim();
        if (typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
            const v = searchKey(obj[k], target);
            if (v) return v;
        }
    }
    return '';
}

function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current);
    return result;
}
