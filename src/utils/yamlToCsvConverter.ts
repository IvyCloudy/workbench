/**
 * ============================================================================
 *  utils/yamlToCsvConverter.ts
 *  YAML 案例文件 → CSV 格式转换
 * ----------------------------------------------------------------------------
 *  输入：YAML 文件名（绝对/相对路径）
 *  输出：按 CSV 格式（与 examples/case_example.csv 表头一致）组装的内容字符串
 * ============================================================================
 */

import * as fs from 'fs';
import * as YAML from 'yaml';
import { toStr, toLines, joinLines, fieldOrDefault } from './pushDataMapper';

// CSV 表头（字段名与推送测试案例接口一致，不在推送中的保持 YAML 原名）
const CSV_FIXED_HEADER = 'testcase_id,testCasePath,testCaseName,testCaseDes,preCondition,description,expected,type,priority,testType,keyFlag,projectDes,planExecNum';

/** 已被固定映射的 YAML 字段（steps 拆为 description / expected 两列） */
const MAPPED_YAML_KEYS = new Set([
    'testcase_id', 'path', 'name', 'description', 'preconditions',
    'steps', 'type', 'priority', 'test_type',
    'key_flag', 'project_des', 'plan_exec_num'
]);

/** 收集所有案例的额外字段名（YAML 中存在但未被固定映射的 key） */
function collectExtraKeys(cases: any[]): string[] {
    const keys = new Set<string>();
    for (const item of cases) {
        if (!item || typeof item !== 'object') continue;
        for (const key of Object.keys(item)) {
            if (!MAPPED_YAML_KEYS.has(key)) {
                keys.add(key);
            }
        }
    }
    return Array.from(keys);
}

/**
 * 将字符串转为 CSV 安全格式：
 * - 包含逗号、双引号或换行符时用双引号包裹，内部 `"` → `""`
 * - 普通字符串原样返回
 */
function escapeCsvCell(value: string): string {
    if (value.indexOf(',') >= 0 || value.indexOf('"') >= 0 || value.indexOf('\n') >= 0) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}

/**
 * 将步骤数组重建成「步骤描述」列的文本
 * 格式：步骤N:\n{operation}\n{data per line}
 *
 * 示例输出：
 *   步骤1：
 *   步骤名称1
 *   步骤数据1
 *   步骤数据2
 *   步骤2:
 *   步骤名称2
 *   步骤数据1
 */
function buildStepDescription(steps: any[]): string {
    if (!Array.isArray(steps) || steps.length === 0) return '';

    return steps
        .map((step) => {
            if (!step || typeof step !== 'object') return '';
            const lines: string[] = [];
            lines.push('步骤' + String(step.id ?? '?') + '：');

        const operation = toStr(step.operation).trim();
        if (operation) lines.push(operation);

        const dataLines = toLines(step.data).filter((l: string) => l.trim() !== '');
        dataLines.forEach((l: string) => lines.push(l));
            return lines.join('\n');
        })
        .filter((s) => s !== '')
        .join('\n');
}

/**
 * 将步骤数组重建成「预期结果」列的文本
 * 格式：步骤N:\n【UI检查】\n{ui}\n【接口调用】\n{api}\n【数据检查】\n{db}
 *       缺失类型不输出该段
 *
 * 示例输出：
 *   步骤1:
 *   【UI检查】
 *   UI检查点
 *   【接口调用】
 *   接口检查点
 *   【数据检查】
 *   数据检查点
 *   步骤3:
 *   【数据检查】
 *   数据检查点
 */
function buildStepExpected(steps: any[]): string {
    if (!Array.isArray(steps) || steps.length === 0) return '';

    return steps
        .map((step) => {
            if (!step || typeof step !== 'object') return '';
            const lines: string[] = [];
            lines.push('步骤' + String(step.id ?? '?') + ':');

            const ui = toLines(step.ui_expected).filter((l: string) => l.trim() !== '');
            const api = toLines(step.api_expected).filter((l: string) => l.trim() !== '');
            const db = toLines(step.db_expected).filter((l: string) => l.trim() !== '');

            if (ui.length) {
                lines.push('【UI检查】');
                ui.forEach((v: any) => lines.push(String(v)));
            }
            if (api.length) {
                lines.push('【接口调用】');
                api.forEach((v: any) => lines.push(String(v)));
            }
            if (db.length) {
                lines.push('【数据检查】');
                db.forEach((v: any) => lines.push(String(v)));
            }

            return lines.length > 1 ? lines.join('\n') : '';
        })
        .filter((s) => s !== '')
        .join('\n');
}

/**
 * 将 YAML 案例文件转换为 CSV 格式文本。
 *
 * @param yamlFilePath - YAML 文件路径（绝对或相对于工作区）
 * @returns CSV 格式的内容字符串（含表头行）
 */
export function yamlToCsv(yamlFilePath: string): string {
    // 1) 读取并解析 YAML
    const raw = fs.readFileSync(yamlFilePath, 'utf-8');
    const parsed = YAML.parse(raw);

    // 2) 归一化为案例数组
    let cases: any[];
    if (Array.isArray(parsed)) {
        cases = parsed;
    } else if (parsed && typeof parsed === 'object') {
        cases = [parsed];
    } else {
        throw new Error('YAML 文件内容不是有效的案例数据：' + yamlFilePath);
    }
    if (cases.length === 0) {
        return CSV_FIXED_HEADER;
    }

    // 3) 收集额外字段（YAML 中存在但未被固定映射的 key）
    const extraKeys = collectExtraKeys(cases);
    const header = extraKeys.length
        ? CSV_FIXED_HEADER + ',' + extraKeys.join(',')
        : CSV_FIXED_HEADER;

    // 4) 逐案例构建 CSV 行
    const rows: string[] = [header];

    for (const item of cases) {
        if (!item || typeof item !== 'object') continue;

        const testcaseId = toStr(item.testcase_id).trim();
        const caseTag = testcaseId || toStr(item.name) || '(未命名案例)';

        // testcase_id 必填
        if (testcaseId === '') {
            throw new Error(`案例 [${caseTag}] 缺少 testcase_id，请补全。`);
        }

        const path = toStr(item.path);
        const name = toStr(item.name);
        const desc = toStr(item.description);

        // 前置条件：数组/字符串统一用 toLines 按 \n 拼接
        const preconditions: string = joinLines(item.preconditions);

        // 步骤描述 & 预期结果
        const stepDesc = buildStepDescription(item.steps);
        const stepExpected = buildStepExpected(item.steps);

        const type = toStr(item.type);
        const priority = toStr(item.priority);

        // testType：执行方式 → 空或'手工' → '手工'；其他 → '自动化'
        const testTypeRaw = toStr(item.test_type).trim();
        const testType = (!testTypeRaw || testTypeRaw === '手工') ? '手工' : '自动化';

        // 推送案例额外字段
        const keyFlag = fieldOrDefault(item, 'key_flag', '否');
        const projectDes = fieldOrDefault(item, 'project_des', '');
        const planExecNum = fieldOrDefault(item, 'plan_exec_num', 1);

        const cells = [
            escapeCsvCell(testcaseId),
            escapeCsvCell(path),
            escapeCsvCell(name),
            escapeCsvCell(desc),
            escapeCsvCell(preconditions),
            escapeCsvCell(stepDesc),
            escapeCsvCell(stepExpected),
            escapeCsvCell(type),
            escapeCsvCell(priority),
            escapeCsvCell(testType),
            escapeCsvCell(toStr(keyFlag)),
            escapeCsvCell(toStr(projectDes)),
            escapeCsvCell(toStr(planExecNum)),
            // 额外字段：按表头顺序拼接，缺失则空字符串
            ...extraKeys.map((k) => escapeCsvCell(toStr(item[k]))),
        ];
        rows.push(cells.join(','));
    }

    return rows.join('\n');
}
