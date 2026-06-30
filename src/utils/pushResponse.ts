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
        if (t === '1') successMappings.push({ tsId: sid, testCaseNo: dataField });
        else if (t === '2') failures.push({ tsId: sid, reason: dataField, bodyIndex: bi });
    });
    return { successMappings, failures };
}
