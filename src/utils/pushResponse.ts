/**
 * ============================================================================
 *  utils/pushResponse.ts
 *  推送响应解析工具
 * ----------------------------------------------------------------------------
 *  职责：
 *    解析后端推送接口返回的 body 数组，提取成功/失败项。
 *    type=1 → 成功（data 为 testCaseNo）
 *    type=2 → 失败（data 为错误原因）
 * ============================================================================
 */

import { TS_ID_COLUMN } from '../services/utils';
import { classifyFailure, extractInterfaceField, type PushFailCategory, type PushInterfaceField } from './pushFailureCategory';

// ============================================
// 类型定义
// ============================================

/** 推送成功映射项 */
export interface PushSuccessMapping {
    tsId: string;
    testCaseNo: string;
}

/** 推送响应中的失败项（含 bodyIndex 便于按 payload 下标兜底定位行号） */
export interface PushResponseFailure {
    tsId: string;
    reason: string;
    bodyIndex: number;
    /** 失败分类码（后端中文文本经关键词归类，统计/埋点用稳定维度） */
    category: PushFailCategory;
    /** 命中的接口字段码（聚焦维度；字段类错误才有值，其余为 undefined） */
    field?: PushInterfaceField;
    /** 客户端字段映射错误的 reason 码（如 missingTestcaseId），用于精确归类到 字段.性质 复合码 */
    mapErrorReason?: string;
}

/** parsePushResponse 返回值 */
export interface PushResponseResult {
    successMappings: PushSuccessMapping[];
    failures: PushResponseFailure[];
}

// ============================================
// 解析函数
// ============================================

/**
 * 解析推送响应 body，提取成功/失败项。
 * @param body          后端返回的 body 数组
 * @param pushData      可选，推送原始数据；用于当后端不返回 sourceId 时按 bodyIndex 兜底反查 tsId
 */
export function parsePushResponse(
    body: any[],
    pushData?: any[],
): PushResponseResult {
    const safeBody: any[] = Array.isArray(body) ? body : [];
    const successMappings: PushSuccessMapping[] = [];
    const failures: PushResponseFailure[] = [];
    safeBody.forEach((item, bi) => {
        if (!item) return;
        const t = String(item.type == null ? '' : item.type);
        let sid = String(item.sourceId == null ? '' : item.sourceId);
        // 后端可能对失败行不返回 sourceId，按 bodyIndex 从 pushData 反查 testcase_id 兜底
        if (!sid && Array.isArray(pushData) && pushData[bi]) {
            const fallback = (pushData[bi] as any)?.[TS_ID_COLUMN];
            if (fallback != null && fallback !== '') sid = String(fallback);
        }
        const dataField = item.data == null ? '' : String(item.data);
        // 仅 type==='1' 视为成功；其余（'2' 失败 / 未知 type / 缺失 type）一律计入失败。
        // 关键修复：历史上"未知 type"项会被静默丢弃，既不计入成功也不计入失败，
        // 导致 successCount + failures.length < total，部分行的接口结果凭空消失，
        // 表现为"推送结果数据对不上 / 接口失败未合并"。现在任何非成功项都必须有归属。
        if (t === '1') {
            successMappings.push({ tsId: sid, testCaseNo: dataField });
        } else {
            const reason = dataField
                || (t === '2' ? '推送失败' : `推送响应未返回明确结果（type=${t || '空'}）`);
            failures.push({
                tsId: sid,
                reason,
                bodyIndex: bi,
                category: classifyFailure({ reason }),
                field: extractInterfaceField(reason),
            });
        }
    });
    return { successMappings, failures };
}
