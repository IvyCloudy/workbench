/**
 * ============================================================================
 *  utils/fileUtils.ts
 *  文件 / 字段路径相关的公共工具方法
 * ----------------------------------------------------------------------------
 *  职责：集中提供与案例文件字段路径相关的公共能力，避免各模块散落重复逻辑。
 * ============================================================================
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { createLogger } from './logger';

const log = createLogger('fileUtils');

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
    } catch (err: any) {
        // 文件/文件夹不存在或读取失败（权限不足等）：打印报错与日志，避免静默吞掉异常
        console.error(`[fileUtils] getFileIds 读取失败 path=${path}`, err);
        log.error(`getFileIds 读取失败 path=${path}`, err?.message || err);
        return {
            file_id: '',
            device_id: '',
        };
    }
}

/**
 * 将绝对路径转换为基于工作区根目录的相对路径。
 * 若无法获取工作区根（未打开工作区 / 文件不在工作区内），则原样返回绝对路径。
 *
 * @param absPath 文件或文件夹的绝对路径
 * @returns 相对工作区的路径；无工作区时回退为原绝对路径
 */
export function toWorkspaceRelativePath(absPath: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return absPath;
    return path.relative(workspaceRoot, absPath);
}
