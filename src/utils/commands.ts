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
import { FILE_PATTERNS } from '../services/utils';
import { findBindingByPath } from './taskInfoStore';

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
 *   1. 通过 findBindingByPath(filePath) 查找绑定点
 *   2. 从文件内容提取 testPhaseName
 *   3. 在 binding.testPhaseList 中查 phaseId
 *   4. 全部齐备返回 bind=true，否则 bind=false
 */
export async function getTaskInfoByFilePath(
    context: vscode.ExtensionContext,
    filePath: string
): Promise<GetTaskInfoResult> {
    if (!filePath) return { bind: false, taskInfo: {} };

    // Step1: 查找绑定
    const entry = findBindingByPath(filePath);
    if (!entry || !entry.bind || !entry.taskInfo) return { bind: false, taskInfo: {} };

    const info = entry.taskInfo!;

    // Step2: 提取 testPhaseName
    const testPhaseName = await extractTestPhaseName(filePath);
    if (!testPhaseName) return { bind: false, taskInfo: {} };

    // Step3: 在 testPhaseList 中查找匹配的阶段 ID
    let phaseId = 0;
    if (info.testPhaseList && Array.isArray(info.testPhaseList)) {
        const matched = info.testPhaseList.find(p => p.testPhaseName === testPhaseName);
        if (matched && matched.testPhaseId != null) {
            phaseId = matched.testPhaseId;
        }
    }
    // 向后兼容：如果当前阶段的名称等于文件中的阶段名，直接取 testPhaseId
    if (phaseId === 0 && info.testPhaseName === testPhaseName && info.testPhaseId != null) {
        phaseId = info.testPhaseId;
    }
    if (phaseId === 0) {
        return { bind: false, taskInfo: {} };
    }

    // Step4: 各字段齐备校验
    if (!info.testTaskNo || !info.testTaskName ||
        info.subTestTaskId == null || !info.subTestTaskName) {
        return { bind: false, taskInfo: {} };
    }

    return {
        bind: true,
        taskInfo: {
            testTaskNo: info.testTaskNo,
            testTaskName: info.testTaskName,
            subTestTaskId: Number(info.subTestTaskId),
            subTestTaskName: info.subTestTaskName,
            testPhaseName,
            phaseId,
        },
    };
}

// ============================================
// 公共：获取当前文件所属的测试任务信息
// ============================================

/** 表头展示用任务信息（与 getCurrentTaskInfo 返回的 taskInfo 对应）。 */
export interface CurrentTaskInfo {
    testTaskNo: string;
    testTaskName: string;
    subTestTaskName: string;
}

/** getCurrentTaskInfo 返回格式：bind 标记 + taskInfo 对象（未绑定时 taskInfo 为空）。 */
export interface GetCurrentTaskInfoResult {
    /** 是否在 task-bindings.json 中命中绑定（用于第一行最左侧的状态标签） */
    bind: boolean;
    /**
     * 命中绑定时为 { testTaskNo, testTaskName, subTestTaskName }；
     * 未命中时为空对象 {}。
     */
    taskInfo: CurrentTaskInfo | Record<string, never>;
}

/**
 * 根据文件全路径获取当前所属的测试任务信息（表头 + 推送用）。
 *
 * 命中规则：
 *   - findBindingByPath(fullPath) 找到绑定点
 *   - 命中 → 返回绑定文件中的 testTaskNo / testTaskName / subTestTaskName
 *   - 未命中 → taskInfo 为空对象 {}（UI 层会渲染为占位符 "-"）
 */
export async function getCurrentTaskInfo(fullPath: string): Promise<GetCurrentTaskInfoResult> {
    const empty: GetCurrentTaskInfoResult = { bind: false, taskInfo: {} };
    if (!fullPath) return empty;

    const entry = findBindingByPath(fullPath);
    if (!entry || !entry.bind || !entry.taskInfo) return empty;

    return {
        bind: true,
        taskInfo: {
            testTaskNo: entry.taskInfo.testTaskNo || '',
            testTaskName: entry.taskInfo.testTaskName || '',
            subTestTaskName: entry.taskInfo.subTestTaskName || '',
        },
    };
}

/** @deprecated 使用 GetCurrentTaskInfoResult 替代 */
export type HeaderTaskInfo = GetCurrentTaskInfoResult;

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
