/**
 * ============================================================================
 *  utils/fileUtils.ts
 *  文件 / 字段路径相关的公共工具方法
 * ----------------------------------------------------------------------------
 *  职责：集中提供与案例文件字段路径相关的公共能力，避免各模块散落重复逻辑。
 * ============================================================================
 */

import * as fs from 'fs';

/** 字段路径结构：案例文件相关的标识字段 */
export interface FieldsPath {
    file_id: string;
    device_id: string;
}

/**
 * 通过 Node.js fs.promises 异步读取文件/文件夹的标识信息。
 *   - file_id：以 `0x` + 16 位十六进制 inode 号（ino）作为唯一标识，
 *              即 `0x${stat.ino.toString(16).padStart(16,'0')}`
 *   - device_id：使用 stat 的 dev 号（所在文件系统的设备编号）作为设备标识
 *
 * 使用 fs.promises.stat（bigint: true）同时兼容文件和文件夹（目录同样拥有 ino / dev 属性）。
 *
 * @param path 文件或文件夹路径
 * @returns Promise<字段路径对象 { file_id, device_id }>；
 *          路径不存在或读取失败时两者均为空字符串
 */
export async function getFileIds(path: string): Promise<FieldsPath> {
    try {
        const stat = await fs.promises.stat(path, { bigint: true });
        const file_id = `0x${stat.ino.toString(16).padStart(16, '0')}`;
        return {
            file_id,
            device_id: String(stat.dev),
        };
    } catch {
        return {
            file_id: '',
            device_id: '',
        };
    }
}
