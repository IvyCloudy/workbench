/**
 * ============================================================================
 *  providers/common/FileTreeService.ts
 *  合规目录结构识别服务
 * ----------------------------------------------------------------------------
 *  职责：从工作区根目录出发，返回符合业务约定的测试案例文件树：
 *    .../测试任务/<task>/测试案例/[...]/<file>.<csv|yaml|yml|json>
 *  支持 测试案例/ 目录下的多级子目录递归扫描。
 *  主调用方：TableBrowserProvider 进行「表格浏览」渲染。
 *  说明：仅负责文件结构产出，不解析文件内容。
 * ============================================================================
 */
import * as fs from 'fs';
import * as path from 'path';
import type { FileNode } from '../../types';

/** 支持的测试案例文件后缀 */
const CASE_FILE_PATTERN = /\.(csv|ya?ml|json)$/i;

// ============================================
// 文件树服务
// ============================================

export class FileTreeService {
    /**
     * 构建工作区文件树
     */
    buildWorkspaceFileTree(rootPath: string): FileNode[] {
        const result: FileNode[] = [];

        try {
            const firstLevelEntries = fs.readdirSync(rootPath, { withFileTypes: true });

            for (const firstEntry of firstLevelEntries) {
                if (!firstEntry.isDirectory() || firstEntry.name !== '测试任务') {
                    continue;
                }

                const testTaskPath = path.join(rootPath, firstEntry.name);
                const taskChildren: FileNode[] = [];

                try {
                    const secondLevelEntries = fs.readdirSync(testTaskPath, { withFileTypes: true });

                    for (const secondEntry of secondLevelEntries) {
                        if (!secondEntry.isDirectory()) continue;

                        const subTaskPath = path.join(testTaskPath, secondEntry.name);
                        const caseChildren: FileNode[] = [];

                        try {
                            const thirdLevelEntries = fs.readdirSync(subTaskPath, { withFileTypes: true });

                            for (const thirdEntry of thirdLevelEntries) {
                                if (!thirdEntry.isDirectory() || thirdEntry.name !== '测试案例') {
                                    continue;
                                }

                                const casePath = path.join(subTaskPath, thirdEntry.name);
                                const files = this.getCaseFilesRecursive(casePath);

                                if (files.length > 0) {
                                    caseChildren.push({
                                        name: thirdEntry.name,
                                        path: casePath,
                                        isDirectory: true,
                                        children: files
                                    });
                                }
                            }
                        } catch (e) {
                            console.error(`[FileTreeService] Error reading directory ${subTaskPath}:`, e);
                        }

                        if (caseChildren.length > 0) {
                            taskChildren.push({
                                name: secondEntry.name,
                                path: subTaskPath,
                                isDirectory: true,
                                children: caseChildren
                            });
                        }
                    }
                } catch (e) {
                    console.error(`[FileTreeService] Error reading directory ${testTaskPath}:`, e);
                }

                if (taskChildren.length > 0) {
                    result.push({
                        name: firstEntry.name,
                        path: testTaskPath,
                        isDirectory: true,
                        children: taskChildren
                    });
                }
            }
        } catch (e) {
            console.error('[FileTreeService] Error building file tree:', e);
        }

        return result;
    }

    /**
     * 递归获取目录下所有测试案例文件（支持 csv/yaml/yml/json）
     */
    private getCaseFilesRecursive(dirPath: string): FileNode[] {
        const result: FileNode[] = [];
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    // 递归扫描子目录
                    const subFiles = this.getCaseFilesRecursive(entryPath);
                    if (subFiles.length > 0) {
                        result.push({
                            name: entry.name,
                            path: entryPath,
                            isDirectory: true,
                            children: subFiles
                        });
                    }
                } else if (CASE_FILE_PATTERN.test(entry.name)) {
                    result.push({
                        name: entry.name,
                        path: entryPath,
                        isDirectory: false
                    });
                }
            }
        } catch (e) {
            console.error(`[FileTreeService] Error reading directory ${dirPath}:`, e);
        }
        return result;
    }
}