import * as fs from 'fs';
import * as path from 'path';
import type { FileNode } from '../../types';

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
                if (!firstEntry.isDirectory() || (firstEntry.name !== '测试任务' && firstEntry.name !== 'testtask')) {
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
                                if (!thirdEntry.isDirectory() || (thirdEntry.name !== '测试案例' && thirdEntry.name !== 'testcase')) {
                                    continue;
                                }

                                const casePath = path.join(subTaskPath, thirdEntry.name);
                                const csvFiles = this.getCsvFilesInDir(casePath);

                                if (csvFiles.length > 0) {
                                    caseChildren.push({
                                        name: thirdEntry.name,
                                        path: casePath,
                                        isDirectory: true,
                                        children: csvFiles
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
     * 获取目录中的CSV文件
     */
    private getCsvFilesInDir(dirPath: string): FileNode[] {
        const csvFiles: FileNode[] = [];
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() && /\.csv$/i.test(entry.name)) {
                    csvFiles.push({
                        name: entry.name,
                        path: path.join(dirPath, entry.name),
                        isDirectory: false
                    });
                }
            }
        } catch (e) {
            console.error(`[FileTreeService] Error reading directory ${dirPath}:`, e);
        }
        return csvFiles;
    }

    /**
     * 检查路径是否存在
     */
    pathExists(filePath: string): boolean {
        try {
            return fs.existsSync(filePath);
        } catch {
            return false;
        }
    }

    /**
     * 获取文件统计信息
     */
    getFileStats(filePath: string): fs.Stats | null {
        try {
            return fs.statSync(filePath);
        } catch {
            return null;
        }
    }
}