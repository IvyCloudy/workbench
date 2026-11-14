/**
 * 案例行字段读取（纯函数层）
 * ----------------------------------------------------------------------------
 * 统一 `testcase_id` / 名称 / 路径字段的读取口径，供行级校验器（preValidate/validators）
 * 与路径合法性校验（utils/casePathValidator）共用，避免各自维护别名表与大小写兼容逻辑
 * 而产生判定差异（例如「重复案例名称」漏报、YAML 通路只认 `rec.path` 而静默跳过）。
 *
 * 约定：
 *   · 精确别名优先，其次按「去空白 + 小写」匹配表头大小写变体；
 *   · 字段存在即取该值，null / 空串 / 全空白统一标准化为 ''；
 *   · `present=false` 表示字段完全缺省，供必填校验跳过未使用该字段的旧模板。
 * 注意：字段取值口径以推送映射层 utils/pushDataMapper 为准 —— YAML/JSON 源数据键
 *   只有英文，中文只是 headerLabels 的显示映射；CSV 表头是规范中文列名。
 *   此处只列这两套规范键，不兼容中文变体表头（变体由缺列校验在文件层拦下）。
 */
import { TS_ID_COLUMN } from '../services/utils';
import { isSampleTsId } from './fileIdentifier';
import type { PushInterfaceField } from './pushFailure';

export { TS_ID_COLUMN } from '../services/utils';

/** 案例路径规范键：YAML `path` / CSV「路径」（与 pushDataMapper 一致） */
export const CASE_PATH_COLUMN_ALIASES: readonly string[] = ['path', '路径'];
/** 案例名称规范键：YAML `name` / CSV「名称」（与 pushDataMapper 一致） */
export const CASE_NAME_COLUMN_ALIASES: readonly string[] = ['name', '名称'];

/** 路径列的展示标签 / 接口字段码 / 失败项展示口径（行级失败项统一取用） */
export const CASE_PATH_COLUMN_LABEL = '案例路径';
export const CASE_PATH_FIELD: PushInterfaceField = 'testCasePath';
/**
 * 路径合法性校验 reason 的类别前缀。
 * 与「问题列」解耦：columnName 仍取 CASE_PATH_COLUMN_LABEL 做列定位/高亮，
 * reason 前缀改为标明问题类别（"路径问题："），不再复用列名，避免把类别与列定位混为一谈。
 */
export const CASE_PATH_REASON_PREFIX = '路径问题';
/** 保持字面量不变：validators.classifyFailure 依赖 reason 归类 */
export const CASE_PATH_EMPTY_REASON = '案例路径未填写';

export interface CaseFieldValue {
    /** 是否找到该字段（含大小写变体）；字段完全缺省时为 false */
    present: boolean;
    /** 标准化后的字段值：null / 空串 / 全空白 → '' */
    value: string;
}

/** 读取行对象的标准化 tsId（trim + 空值兜底为 ''） */
export function readCaseTsId(rec: any): string {
    const raw = rec?.[TS_ID_COLUMN];
    return raw == null ? '' : String(raw).trim();
}

/** 中文模板样例 tsId 判定（与 fileIdentifier.isSampleTsId 同口径） */
export function isSampleCaseTsId(tsId: any): boolean {
    return isSampleTsId(tsId);
}

/** 中文模板样例行判定（行对象版本） */
export function isSampleCaseRow(rec: any): boolean {
    return isSampleTsId(readCaseTsId(rec));
}

/** 按别名读取行字段，兼容表头大小写 / 空白变体 */
export function readCaseField(rec: any, aliases: readonly string[]): CaseFieldValue {
    if (!rec || typeof rec !== 'object') return { present: false, value: '' };
    const keys = Object.keys(rec);
    const pick = (key: string): CaseFieldValue => {
        const raw = rec[key];
        return { present: true, value: raw == null ? '' : String(raw).trim() };
    };
    // 1) 精确别名优先，保持既有的优先级与 null 口径（字段存在即取，不回退到下一别名）
    for (const alias of aliases) {
        if (Object.prototype.hasOwnProperty.call(rec, alias)) return pick(alias);
    }
    // 2) 大小写 / 空白变体（CSV RowLike 以表头原样为 key）
    for (const alias of aliases) {
        const target = String(alias).trim().toLowerCase();
        const key = keys.find(k => String(k).trim().toLowerCase() === target);
        if (key !== undefined) return pick(key);
    }
    return { present: false, value: '' };
}

/** 便捷读取：只取标准化值（缺省返回 ''） */
export function readCaseFieldValue(rec: any, aliases: readonly string[]): string {
    return readCaseField(rec, aliases).value;
}

/**
 * 在表头数组中按别名查找列下标（精确别名优先，其次大小写 / 空白变体），找不到返回 -1。
 * 供 CSV 二维数组通路定位路径列 / tsId 列，与行对象通路的 readCaseField 口径一致。
 */
export function findCaseColumnIndex(headers: readonly unknown[], aliases: readonly string[]): number {
    const hs = Array.isArray(headers) ? headers : [];
    for (const alias of aliases) {
        const idx = hs.findIndex(h => String(h).trim() === alias);
        if (idx >= 0) return idx;
    }
    for (const alias of aliases) {
        const target = String(alias).trim().toLowerCase();
        const idx = hs.findIndex(h => String(h).trim().toLowerCase() === target);
        if (idx >= 0) return idx;
    }
    return -1;
}
