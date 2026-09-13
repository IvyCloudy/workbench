/**
 * ============================================================================
 *  workspaceListeners.ts
 *  注册工作区文件变化监听器（重命名、删除）
 * ----------------------------------------------------------------------------
 *  案例文件删除拦截（新方案：will 只备份、did 立即恢复、插件自主决策）：
 *
 *    ★ 输入形态支持：单个文件、多个文件、以及**包含案例文件的文件夹**
 *      —— 文件夹形态在 will 阶段被递归展开为其下所有 isCaseFile 命中的文件，
 *         之后与「多个文件」形态完全共用后续 backup / restore / 决策 / 弹窗流程。
 *         父目录若被 VSCode 递归 unlink，restoreCaseFile 会 mkdir -p 后再拷回。
 *
 *    1. onWillDeleteFiles 阶段（文件被物理删除之前）**只做同步备份**：
 *         - 优先 fs.copyFileSync 把原文件字节级备份到 os.tmpdir；
 *         - copyFileSync 失败时，降级为 parser.stringify + fs.writeFileSync
 *           把 parser 序列化后的 YAML/CSV/JSON 写到 tmp（内容级备份）；
 *         - 双重失败时记录 restoreTableData/restoreSourceData 到内存快照，
 *           did 阶段用 parser.save 兜底。
 *       备份完成即 resolve waitUntil（毫秒级返回），让 VSCode 立即完成物理删除。
 *       ★ 不再在 will 阶段做预检、弹确认、调线上接口，因此**不再受 VSCode 内部
 *         waitUntil 超时（约 5s ~ 10min，不可控）的强制放行影响**。
 *
 *    2. onDidDeleteFiles 阶段完成**全部决策**：
 *         a. 立即把所有案例文件从 tmp 拷回原路径（毫秒级、并行；此时文件"闪一下"就回来）；
 *         b. 排队串行弹确认框（批量场景下逐个文件独立确认，避免多 tab 同时闪现）；
 *         c. 用户确认 → 走 syncDeletedRows 调用线上删除接口；
 *         d. 根据同步结果决定：
 *              · 全部成功 → 关闭 tab（若已开）+ 主动 unlink 原文件（真删）；
 *              · 部分成功 → 用 parser.save 覆写为"仅失败行"版本 + 重开 tab 反馈；
 *              · 用户取消 / 预检失败 / 接口异常 → 保留已拷回的原文件 + 重开 tab（若原本已开）。
 *
 *    3. 关键设计：
 *         - reject waitUntil 无效（VSCode 内部用 Promise.allSettled 收口），
 *           因此不再尝试"阻断 VSCode 的 unlink"，而是"让它删、我立刻拷回、再自主决定要不要真删"；
 *         - reopen tab 只在"最终判定保留文件"时才发生（决策 2B），避免真删场景 tab 抖动；
 *         - 弹窗使用 showDeleteResult（案例编辑器 panel 内 modal），与"案例编辑器里
 *           右键删除案例行"的反馈方式保持一致；用户取消时不弹任何 modal。
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCreatedByCommand, markAsCreatedByCommand, unmarkAsCreatedByCommand } from '../utils/fileIdentifier';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { removeHighlightFile } from '../utils/highlightStore';
import { cleanupCaseFileTraces } from '../utils/caseFileCleanup';
import {
    renamePathInBindings,
    removePathInBindings,
} from '../utils/pointCaseBindingStore';
import { detectFileType, createParser } from '../parsers';
import { syncDeletedRows } from '../utils/deletedRowsStore';
import { TS_ID_COLUMN, isInTempFolder } from '../services/utils';
import { resolveTaskInfoOrNull } from './pushCore.stages';
import { TelemetryService } from '../utils/telemetry';
import { showModal } from '../utils/message';
import {
    confirmCaseFileDeleteWithDetails,
    reportDeleteResult,
} from '../utils/deleteFeedback';
import { showDeleteConfirmSimpleModal, showBatchDeleteConfirmModal } from '../utils/messageExtras';
import type { PushFailure, DeleteConfirmItem } from '../utils/deleteFeedback';
import type { BatchDeleteFileEntry } from '../utils/messageExtras';
import { confirmDeleteTestCase } from '../services/http';
// 批量删除结果汇总面板：复用批量推送的 pushUI（同一 webview 组件，onOpenFile 点击才打开文件）
import { showPushSummary } from '../utils/pushUI';
import type { PushFileResult } from '../utils/pushUI';

/** 案例编辑器 viewType（保持与 BaseEditorProvider 注册值一致） */
const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

/** 若某文件的扩展名属于 point/case 绑定域，才有必要通知绑定库 */
function isBindingRelevant(fp: string): boolean {
    const ext = (fp.match(/\.[^./\\]+$/) || [''])[0].toLowerCase();
    return ['.md', '.xmind', '.csv', '.yaml', '.yml', '.json'].includes(ext);
}

/**
 * 是否位于「测试任务/xxx/测试案例/」下且可解析为案例文件（csv/yaml/json）。
 *
 * 排除规则（与 services/utils.ts 的 isInQualifiedDir 对齐）：
 *   - 位于「临时文件」文件夹内的文件一律返回 false，不识别为测试案例；
 *   - 因此删除单个/批量/文件夹（含临时文件夹）都不会触发本插件的删除拦截确认，
 *     交给 VSCode 按普通文件正常删除，避免出现「临时文件误弹 TMS 同步确认」。
 */
function isCaseFile(fp: string): boolean {
    if (!fp) return false;
    const norm = fp.replace(/\\/g, '/');
    if (!/\/测试任务\/[^/]+\/测试案例\//.test(norm)) return false;
    if (isInTempFolder(fp)) return false;
    return detectFileType(fp) !== null;
}

/**
 * 同步递归收集给定目录下所有命中 isCaseFile 的文件绝对路径。
 *
 * 用途：onWillDeleteFiles 阶段用户删除的可能是**文件夹**（VSCode 只把文件夹本身报到 event.files，
 * 不会展开其下文件）；本函数把文件夹展开为一组「具体案例文件」，让后续 backup/restore 流程
 * 完全复用「多文件删除」路径。
 *
 * 设计约束：
 *   - **必须同步**：waitUntil 是限时的（默认 5s），不能用 fs.promises.*；
 *   - **必须容错**：遇到不可读/无权限目录时静默跳过，绝不抛异常（拖住 waitUntil）；
 *   - **仅扫描案例文件**：其它文件（如 .DS_Store、非案例目录）不备份、不干预，交由 VSCode 正常删除；
 *   - **深度不限**：真实业务中「测试案例」下层级可控（通常 ≤3 层），无栈溢出风险。
 */
function collectCaseFilesUnderDir(dirPath: string): string[] {
    const results: string[] = [];
    const stack: string[] = [dirPath];
    let scannedDirs = 0;
    let scannedFiles = 0;
    let readdirErrors = 0;
    while (stack.length > 0) {
        const cur = stack.pop() as string;
        scannedDirs++;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch (readErr: any) {
            readdirErrors++;
            console.warn('[workspaceListeners] collectCaseFilesUnderDir readdirSync 失败（已吞）:',
                cur, '→', readErr?.message || readErr);
            continue;
        }
        for (const ent of entries) {
            const child = path.join(cur, ent.name);
            try {
                if (ent.isDirectory()) {
                    stack.push(child);
                } else if (ent.isFile()) {
                    scannedFiles++;
                    if (isCaseFile(child)) {
                        results.push(child);
                    }
                }
            } catch {
                // 单条 dirent 处理异常也吞掉，避免整个扫描中断
            }
        }
    }
    console.log(`[workspaceListeners] collectCaseFilesUnderDir 完成: dir=${dirPath}, 案例文件=${results.length}, 扫描目录=${scannedDirs}, 扫描文件=${scannedFiles}, readdir 失败=${readdirErrors}`);
    return results;
}

/**
 * 同步判断路径是否为目录；stat 失败（含 ENOENT）一律返回 false。
 * 用于 onWillDeleteFiles 阶段快速区分文件/文件夹（waitUntil 内禁用异步 IO）。
 */
function isExistingDirectory(fp: string): boolean {
    try {
        return fs.statSync(fp).isDirectory();
    } catch {
        return false;
    }
}

/** 是否测试要点（point）文件（.md/.xmind 且位于「测试任务/xxx/测试大纲/」下） */
function isPointFile(fp: string): boolean {
    const norm = (fp || '').replace(/\\/g, '/');
    if (!/\/测试任务\/[^/]+\/测试大纲\//.test(norm)) return false;
    const ext = (norm.match(/\.[^./]+$/) || [''])[0].toLowerCase();
    return ext === '.md' || ext === '.xmind';
}

/**
 * onWillDeleteFiles 阶段的**同步备份**产物，供 onDidDeleteFiles 立即恢复并做决策使用。
 *
 * 新方案下 will 阶段不再涉及"最终意图"，此结构只记录"如何把文件恢复回原状"所需的信息：
 *   - backupPath：优先级最高的字节级备份（fs.copyFileSync 写入 os.tmpdir）；
 *   - backupPathIsSerialized：backupPath 是 parser 序列化后写入（内容级），false=fs.copyFileSync 拷贝（字节级）；
 *   - restoreTableData/restoreSourceData：双重降级时的内存快照（did 阶段 parser.save 兜底）。
 */
interface WillBackupEntry {
    // 注：字段命名保持 restoreTableData/restoreSourceData 语义 —— 仅在"极端降级路径"
    // （will 阶段 copyFileSync 失败后 fallback parse）才会有值；快路径下均为 null。
    // did 阶段 prepareCaseFileDecisionContext 发现为空时会自行 parse，兼容无副作用。
    filePath: string;
    fileName: string;
    /** 删前备份文件绝对路径（位于 os.tmpdir）；undefined 表示磁盘备份完全失败，仅有内存快照可用 */
    backupPath?: string;
    /** true=backupPath 是 parser 序列化后写入（内容级），false=fs.copyFileSync 拷贝（字节级） */
    backupPathIsSerialized: boolean;
    /** parser 解析出的 tableData（backup 全部失败时的最后一道兜底，用 parser.save 重建） */
    restoreTableData: any;
    /** parser 解析出的 sourceData（含格式/注释，parser.save 时透传） */
    restoreSourceData: any;
    /** 删除前文件是否处于"已打开案例编辑器"状态（决策 2B：仅在"保留文件"路径才 reopen） */
    wasOpen: boolean;
}

/** filePath → WillBackupEntry（仅案例文件在 will 阶段写入，did 阶段消费后删除） */
const willBackupEntries = new Map<string, WillBackupEntry>();

/**
 * 只读读取备份条目（不消费）。仅供单元测试断言 will 阶段是否正确写入备份，
 * 生产逻辑请直接从 willBackupEntries 消费。
 */
export function peekWillDeleteResult(fp: string): WillBackupEntry | undefined {
    return willBackupEntries.get(fp);
}

/**
 * 注册所有工作区文件变化监听器
 */
export function registerWorkspaceListeners(context: vscode.ExtensionContext): vscode.Disposable[] {
    return [
        // 监听文件重命名，同步更新记录
        vscode.workspace.onDidRenameFiles((event) => {
            for (const file of event.files) {
                const oldPath = file.oldUri.fsPath;
                const newPath = file.newUri.fsPath;

                if (isCreatedByCommand(oldPath)) {
                    unmarkAsCreatedByCommand(oldPath);
                    markAsCreatedByCommand(newPath);
                }

                BaseEditorProvider.updatePanelMapKey(oldPath, newPath);

                // 同步 point ↔ case 绑定库（重命名或跨目录移动）
                if (isBindingRelevant(oldPath) || isBindingRelevant(newPath)) {
                    renamePathInBindings(oldPath, newPath)
                        .then(changed => {
                            if (changed) {
                                TelemetryService.sendTelemetryEvent('pointCaseBindings.rename.synced', {
                                    ext: (path.extname(newPath) || '').toLowerCase(),
                                });
                            }
                        })
                        .catch(err => {
                            TelemetryService.sendTelemetryErrorEvent('pointCaseBindings.rename.error', {
                                errorMessage: String(err?.message || err).slice(0, 500),
                            });
                        });
                }
            }
        }),

        // ★ 案例文件"将删除"拦截 —— 新方案：**只备份、立即 resolve**
        //   1. onWillDeleteFiles 只做同步 fs.copyFileSync 备份到 os.tmpdir
        //      （毫秒级完成、绝不阻塞 VSCode 内部的 waitUntil 超时）；
        //   2. copyFileSync 失败时降级 parser 序列化写 tmp；再失败时记录内存快照；
        //   3. resolve waitUntil，让 VSCode 秒级完成物理 unlink；
        //   4. 所有预检 / 确认弹窗 / 线上同步 / 真删决策 全部搬到 onDidDeleteFiles 完成。
        //
        //   关键收益：
        //     - 彻底消除"VSCode 内部 waitUntil 超时强制放行"带来的静默丢文件/占位兜底逻辑；
        //     - 用户从 onWillDeleteFiles 触发的物理 unlink 后，本插件在 did 阶段立即拷回原文件，
        //       视觉上文件仅"闪一下"就恢复，随后弹确认框，用户操作明确才决定真删或保留；
        //     - waitUntil 内部只做备份 IO，不再依赖任何超时/竞态兜底。
        vscode.workspace.onWillDeleteFiles((event) => {
            console.log('[workspaceListeners] onWillDeleteFiles 触发, files=', event.files.map(f => f.fsPath));
            const tasks: Promise<void>[] = [];
            // 去重：同一个文件被多次 push（如同时选中文件与其父目录）时只备份一次
            const seenFilePaths = new Set<string>();
            const scheduleBackup = (fp: string) => {
                if (seenFilePaths.has(fp)) return;
                seenFilePaths.add(fp);
                console.log('[workspaceListeners] 命中案例文件删除拦截（仅备份）:', fp);
                tasks.push(
                    backupCaseFileForDelete(fp).catch((err: any) => {
                        // 备份阶段任何未捕获异常都吞掉，避免拖住 waitUntil；
                        // did 阶段发现该文件没有 willBackupEntries 条目时不做任何还原（视为普通文件删除）。
                        console.error('[workspaceListeners] backupCaseFileForDelete 未捕获异常（已吞兜底）:', err?.message || err);
                        TelemetryService.sendTelemetryErrorEvent('caseFileDelete.backup.uncaught', {
                            errorMessage: String(err?.message || err).slice(0, 500),
                            filePath: path.basename(fp),
                        });
                    }),
                );
            };

            for (const file of event.files) {
                const fp = file.fsPath;
                // 情形 A：明确的案例文件 —— 直接备份
                if (isCaseFile(fp)) {
                    scheduleBackup(fp);
                    continue;
                }
                // 情形 B：文件夹 —— 递归收集其下所有案例文件（同步扫描，快速返回）
                const isDir = isExistingDirectory(fp);
                if (isDir) {
                    const inside = collectCaseFilesUnderDir(fp);
                    if (inside.length > 0) {
                        console.log(`[workspaceListeners] 目录删除展开为 ${inside.length} 个案例文件:`, fp, '→', inside);
                        TelemetryService.sendTelemetryEvent('caseFileDelete.folder.expand', {
                            folder: path.basename(fp),
                            caseFileCount: String(inside.length),
                        });
                        for (const cf of inside) scheduleBackup(cf);
                    } else {
                        // 目录内无任何案例文件 —— 常见于删除了非「测试案例」目录、或该目录纯是子目录/非案例扩展名。
                        // 打日志便于用户复现时快速定位为何没弹拦截框。
                        console.log('[workspaceListeners] 目录删除未展开出案例文件（跳过拦截）:', fp);
                    }
                    continue;
                }
                // 情形 C：非案例文件、非目录 —— 不干预
                console.log('[workspaceListeners] 非案例文件且非目录，不干预删除:', fp,
                    '（isCaseFile=false, isExistingDirectory=false — 可能是软链接/已被 unlink/权限不足）');
            }
            if (tasks.length > 0) {
                // 等所有备份完成再 resolve；每个 backupCaseFileForDelete 内部都是快速 IO，通常 <100ms
                event.waitUntil(Promise.all(tasks));
            }
        }),

        // 监听文件删除，同步清理所有本地缓存记录 + 案例文件立即恢复并走决策
        vscode.workspace.onDidDeleteFiles((event) => {
            // ★ 案例文件：统一收集本次事件中所有命中拦截的文件，进入"批量决策"流程；
            //   其余文件走原有 isCreatedByCommand / 绑定库清理分支。
            const caseFilesInThisEvent: WillBackupEntry[] = [];
            // 用于"文件夹删除场景补捞"：VSCode 只把文件夹 URI 报到 event.files，
            // 但 will 阶段我们已把文件夹下的案例文件全部备份到 willBackupEntries，
            // 因此需按"文件夹路径前缀"从 map 里补捞孤儿条目。
            const folderPrefixes: string[] = [];
            for (const file of event.files) {
                const fp = file.fsPath;
                if (isCreatedByCommand(fp)) {
                    unmarkAsCreatedByCommand(fp);
                }

                const entry = willBackupEntries.get(fp);
                if (entry) {
                    willBackupEntries.delete(fp);
                    caseFilesInThisEvent.push(entry);
                    continue; // 案例文件的绑定库清理由决策流程末端统一处理
                }

                // 若本 URI 在 map 中不存在，但 will 阶段可能是把它当作"文件夹"展开了：
                // 记录一个"以此路径 + sep 为前缀"的匹配模式，稍后统一从 map 里补捞。
                // 注意：这里不检查文件是否真为目录（此时已被 VSCode unlink，statSync 必然失败），
                // 而是**无条件**尝试前缀匹配 —— 匹配不到就是空集，无副作用。
                folderPrefixes.push(fp);

                // 同步 point ↔ case 绑定库（删除引用）
                // 注：测试要点文件（.md/.xmind）不在此处清理绑定 —— 其「取消删除→重建」与
                // 「真正删除」的绑定语义由专门的还原流程负责（与案例文件一致：案例文件也通过
                // willBackupEntries 恢复流程精确控制，不会落入此通用分支）。若在此无差别清理，
                // 会导致用户取消删除要点文件时把已绑定的测试案例关系一并清掉。
                if (isBindingRelevant(fp) && !isPointFile(fp)) {
                    removePathInBindings(fp)
                        .then(changed => {
                            if (changed) {
                                TelemetryService.sendTelemetryEvent('pointCaseBindings.delete.synced', {
                                    ext: (path.extname(fp) || '').toLowerCase(),
                                });
                            }
                        })
                        .catch(err => {
                            TelemetryService.sendTelemetryErrorEvent('pointCaseBindings.delete.error', {
                                errorMessage: String(err?.message || err).slice(0, 500),
                            });
                        });
                }
            }

            // 【文件夹删除补捞】按前缀从 willBackupEntries 里补捞所有属于本次事件的孤儿条目。
            //   典型场景：用户删除一个文件夹 → will 阶段展开为 N 个案例文件备份进 map；
            //   did 阶段 event.files 只有文件夹 URI，若不在此补捞，备份将变成永久孤儿，
            //   用户视角=子文件全部丢失。
            if (folderPrefixes.length > 0 && willBackupEntries.size > 0) {
                // 构造归一化后的前缀数组：`prefix + sep`，确保匹配的是"位于该目录下"的子文件，
                // 而不是"路径以该前缀开头"的兄弟文件（避免 /a/foo 误捞 /a/foobar/x.yaml）。
                const prefixesWithSep = folderPrefixes.map(p => p.endsWith(path.sep) ? p : p + path.sep);
                const orphans: string[] = [];
                for (const key of willBackupEntries.keys()) {
                    if (prefixesWithSep.some(pref => key.startsWith(pref))) {
                        orphans.push(key);
                    }
                }
                for (const k of orphans) {
                    const e = willBackupEntries.get(k);
                    if (e) {
                        willBackupEntries.delete(k);
                        caseFilesInThisEvent.push(e);
                    }
                }
                if (orphans.length > 0) {
                    console.log(`[workspaceListeners] 从 willBackupEntries 前缀补捞 ${orphans.length} 个案例文件（文件夹删除场景）`);
                    TelemetryService.sendTelemetryEvent('caseFileDelete.folder.orphanRescue', {
                        rescuedCount: String(orphans.length),
                    });
                }
            }

            if (caseFilesInThisEvent.length > 0) {
                // fire-and-forget：立即并行拷回文件、串行走决策；VSCode 事件回调本身可立即返回
    void handleCaseFilesDidDelete(caseFilesInThisEvent, context).catch(err => {
        console.error('[workspaceListeners] handleCaseFilesDidDelete 未捕获异常:', err?.message || err);
        TelemetryService.sendTelemetryErrorEvent('caseFileDelete.did.uncaught', {
            errorMessage: String(err?.message || err).slice(0, 500),
        });
    });
            }
        }),
    ];
}

/**
 * onWillDeleteFiles 阶段的备份逻辑（毫秒级、绝不阻塞 waitUntil）。
 *
 * 备份三级降级（H1 优化：快路径不 parse）：
 *   1. fs.copyFileSync（首选：字节级完整，保留原始 YAML/CSV/JSON 的注释、空行、字段顺序）；
 *      —— 成功即立即返回，**不做 parser.parse**，把 waitUntil 阻塞压到最短。
 *   2. copyFileSync 失败时才 parse 一次，走 parser.save 序列化写 tmp（内容级完整）；
 *   3. 序列化仍失败时，仅保留内存快照 restoreTableData/restoreSourceData（did 阶段 parser.save 兜底）。
 *
 * 说明：
 *   - did 阶段 prepareCaseFileDecisionContext 内部具备"restoreTableData 为空时重新 parse"能力，
 *     所以快路径省掉 parse 后行为完全兼容；
 *   - 文件夹批量删除场景（20+ 文件）中，此优化将 waitUntil 阻塞时间从 ~1s 降到 ~50ms，
 *     用户视觉上"文件夹消失→拷回"的整体延迟显著缩短。
 */
async function backupCaseFileForDelete(filePath: string): Promise<void> {
    const fileType = detectFileType(filePath);
    if (!fileType) return;

    const entry: WillBackupEntry = {
        filePath,
        fileName: path.basename(filePath),
        backupPath: undefined,
        backupPathIsSerialized: false,
        // 说明（H1 优化）：will 阶段**不再预先 parse**。
        //   - parser.parse 是 CPU 密集操作（YAML/CSV 解析 5~50ms/个），文件夹删除场景 20+ 文件累加
        //     会让 waitUntil 阻塞数百 ms~2s，用户视觉上"删除→消失→拷回"整体变慢。
        //   - 一级 copyFileSync 成功率 99%+，did 阶段 restoreCaseFile 直接从磁盘 tmp 拷回即可，
        //     不需要 tableData 参与恢复。
        //   - did 阶段 prepareCaseFileDecisionContext 发现 restoreTableData 为空时会自动重新 parse，
        //     行为完全兼容。
        //   - 仅当 copyFileSync 极端失败时，本函数才 fallback 到 parse + parser.save 兜底
        //     （见下方 catch 分支），保留原有的二级 / 三级降级能力。
        restoreTableData: null,
        restoreSourceData: null,
        wasOpen: !!BaseEditorProvider.getPanel(filePath),
    };

    // 一级：字节级 copyFileSync 到 tmp（快路径，99%+ 命中，毫秒级）
    const backupPath = path.join(
        os.tmpdir(),
        `caseDelBak-${Date.now()}-${process.pid}-${path.basename(filePath)}`,
    );
    try {
        fs.copyFileSync(filePath, backupPath);
        entry.backupPath = backupPath;
        entry.backupPathIsSerialized = false;
        willBackupEntries.set(filePath, entry);
        return;
    } catch (copyErr: any) {
        // 慢路径：copyFileSync 失败，才需要付出 parse 代价走二级/三级降级
        TelemetryService.sendTelemetryErrorEvent('caseFileDelete.backup.copyFileFailed', {
            errorMessage: String(copyErr?.message || copyErr).slice(0, 500),
            filePath: path.basename(filePath),
        });
    }

    // 二级/三级降级前置：此时才 parse 一次拿内存快照
    const parser = createParser(fileType);
    let tableData: any = null;
    let sourceData: any = null;
    try {
        const parsed = await parser.parse(filePath);
        tableData = parsed.tableData;
        sourceData = parsed.sourceData;
    } catch (parseErr: any) {
        console.warn('[workspaceListeners] backup 降级阶段 parser.parse 失败（放弃兜底）:', parseErr?.message || parseErr);
    }
    entry.restoreTableData = tableData;
    entry.restoreSourceData = sourceData;

    if (tableData) {
        // 二级：parser 序列化写 tmp
        try {
            await parser.save(backupPath, tableData, sourceData);
            entry.backupPath = backupPath;
            entry.backupPathIsSerialized = true;
        } catch (serializeErr: any) {
            // 三级：仅保留内存快照，did 阶段兜底 parser.save 重建
            TelemetryService.sendTelemetryErrorEvent('caseFileDelete.backup.serializeFailed', {
                errorMessage: String(serializeErr?.message || serializeErr).slice(0, 500),
                filePath: path.basename(filePath),
            });
            entry.backupPath = undefined;
        }
    } else {
        // tableData 也拿不到 —— 只能寄望 did 阶段发现无备份、无内存快照时不做还原
        entry.backupPath = undefined;
    }

    willBackupEntries.set(filePath, entry);
}

/**
 * 「批量案例文件删除」的决策入口（did 阶段唯一入口）。
 *
 * 流程（聚合弹窗版）：
 *   1. 并行把所有文件从备份拷回原路径（毫秒级）；
 *   2. 并行 parse + 预检所有文件（每个文件独立跑，互不阻塞）；
 *   3. 汇总预检结果：
 *      - 若 N=1：走原有单文件弹窗（保持体验一致，避免退化）；
 *      - 若 N≥2：**聚合成单一弹窗**，一次决策所有文件；
 *   4. 用户「确定」→ 对预检通过的文件串行执行 syncDeletedRows + 真删/覆写；
 *      预检失败的文件在弹窗中已标注，跳过删除、保留原状（reopen 若原本已开）；
 *   5. 用户「取消」→ 所有文件保留原状（reopen 若原本已开）。
 */
async function handleCaseFilesDidDelete(
    entries: WillBackupEntry[],
    extContext: vscode.ExtensionContext,
): Promise<void> {
    // Step 1: 并行拷回所有文件（毫秒级 IO；此时用户视角"文件闪了一下就回来"）
    await Promise.all(entries.map(async (e) => {
        try {
            await restoreCaseFile(e);
        } catch (err: any) {
            console.error('[workspaceListeners] did 阶段拷回失败:', e.fileName, err?.message || err);
            TelemetryService.sendTelemetryErrorEvent('caseFileDelete.restore.failed', {
                errorMessage: String(err?.message || err).slice(0, 500),
                filePath: path.basename(e.filePath),
            });
        }
    }));

    // Step 2: N=1 走单文件路径（保持体验），N≥2 走聚合路径
    if (entries.length === 1) {
        try {
            await decideAndFinalizeCaseFileDelete(entries[0], extContext);
        } catch (err: any) {
            console.error('[workspaceListeners] 决策/收尾异常:', entries[0].fileName, err?.message || err);
            TelemetryService.sendTelemetryErrorEvent('caseFileDelete.decision.error', {
                errorMessage: String(err?.message || err).slice(0, 500),
                filePath: path.basename(entries[0].filePath),
            });
        }
        return;
    }

    // Step 3: 批量路径 —— 并行 parse + 预检（保留并发以最小化总耗时）
    //   · 使用 withProgress 在右下角展示"正在校验待删案例（X/N）..."，让用户明确知晓进度；
    //   · 使用 allSettled 语义 + 逐个 100s 硬超时，任何单个请求卡住都不会阻塞聚合弹窗；
    //   · 单个请求异常/超时 → 归类为 precheckFailed，进入弹窗聚合展示。
    //   · 双层超时协作：
    //       - L1（http 层）：req.setTimeout(90s) 处理 socket idle 场景，触发后 makeRequest reject
    //         → 走 runOne 的 catch 分支，归类为 precheckFailed。
    //       - L2（本层 100s wall-clock race）：兜底保护，防止 http 层未抛（如响应已回但
    //         .then microtask 卡住）导致预检永久悬挂；100s = 90s SLA + 10s 缓冲
    //         （parse yaml / 前后置逻辑 / 事件循环调度）。
    const PRECHECK_HARD_TIMEOUT_MS = 100_000;
    const total = entries.length;
    let doneCount = 0;
    let startCount = 0;
    console.log('[workspaceListeners] 批量预检开始 total=', total, 'files=', entries.map(e => e.fileName).join(','));
    const contexts = await vscode.window.withProgress<CaseFileDecisionContext[]>({
        location: vscode.ProgressLocation.Notification,
        title: `正在校验待删案例...`,
        cancellable: false,
    }, async (progress) => {
        progress.report({ message: `0/${total} 已完成` });
        return await Promise.all(entries.map(async (entry) => {
            startCount++;
            const idx = startCount;
            console.log(`[workspaceListeners] 预检进入 [${idx}/${total}]`, entry.fileName);
            // 单个预检 + 硬超时竞速
            const runOne = (async (): Promise<CaseFileDecisionContext> => {
                try {
                    const r = await prepareCaseFileDecisionContext(entry, extContext);
                    console.log(`[workspaceListeners] 预检完成 [${idx}/${total}]`, entry.fileName, 'stage=', r.stage);
                    return r;
                } catch (err: any) {
                    console.error('[workspaceListeners] 并行预检异常:', entry.fileName, err?.message || err);
                    TelemetryService.sendTelemetryErrorEvent('caseFileDelete.decision.error', {
                        errorMessage: String(err?.message || err).slice(0, 500),
                        filePath: path.basename(entry.filePath),
                    });
                    return {
                        entry,
                        stage: 'precheckFailed' as const,
                        precheckError: err?.message || String(err) || '预检异常',
                    };
                }
            })();
            const timeoutOne = new Promise<CaseFileDecisionContext>((resolve) => {
                setTimeout(() => {
                    console.warn('[workspaceListeners] 预检硬超时(100s):', entry.fileName);
                    TelemetryService.sendTelemetryErrorEvent('caseFileDelete.decision.timeout', {
                        filePath: path.basename(entry.filePath),
                    });
                    resolve({
                        entry,
                        stage: 'precheckFailed' as const,
                        precheckError: '预检超时（100s），请稍后重试或检查后端服务',
                    });
                }, PRECHECK_HARD_TIMEOUT_MS);
            });
            const ctx = await Promise.race([runOne, timeoutOne]);
            doneCount++;
            const inc = 100 / Math.max(1, total);
            progress.report({
                increment: inc,
                message: `${doneCount}/${total} 已完成 · 最近：${entry.fileName}`,
            });
            return ctx;
        }));
    });
    console.log('[workspaceListeners] 批量预检全部完成 total=', total, 'received=', contexts.length);

    // Step 4: 分类
    //   - hardDelete：无需线上（tsIdx<0 / 空文件 / nonEmptyIds=0）→ 用户确认后直接真删
    //   - needConfirm：预检通过 → 参与聚合确认弹窗
    //   - precheckFailed：预检失败 → 参与聚合弹窗展示，用户确认后跳过、保留文件
    const hardDeleteCtxs: CaseFileDecisionContext[] = [];
    const needConfirmCtxs: CaseFileDecisionContext[] = [];
    const precheckFailedCtxs: CaseFileDecisionContext[] = [];
    for (const ctx of contexts) {
        if (ctx.stage === 'hardDelete') hardDeleteCtxs.push(ctx);
        else if (ctx.stage === 'needConfirm') needConfirmCtxs.push(ctx);
        else precheckFailedCtxs.push(ctx);
    }
    console.log('[workspaceListeners] 批量决策分类完成',
        'hardDelete=', hardDeleteCtxs.length,
        'needConfirm=', needConfirmCtxs.length,
        'precheckFailed=', precheckFailedCtxs.length,
        'files=', entries.map(e => e.fileName).join(','));

    // Step 5: 构造聚合弹窗 entries（hardDelete 也一并展示，让用户知道这些文件会被直接删除）
    const batchEntries: BatchDeleteFileEntry[] = [
        ...hardDeleteCtxs.map(c => ({
            filePath: c.entry.filePath,
            fileName: c.entry.fileName,
            // hardDelete 不涉及线上删除，caseCount（口径为"同步 TMS 案例数"）传 0，
            // 本地行数通过 localRowCount 单独传递，仅用于 pane 内展示。
            caseCount: 0,
            items: [] as DeleteConfirmItem[],
            hardDeleteOnly: true,
            localRowCount: c.stage === 'hardDelete' ? c.rowCount : 0,
        })),
        ...needConfirmCtxs.map(c => ({
            filePath: c.entry.filePath,
            fileName: c.entry.fileName,
            caseCount: c.stage === 'needConfirm' ? c.caseCountForConfirm : 0,
            items: c.stage === 'needConfirm' ? c.confirmItems : [],
        })),
        ...precheckFailedCtxs.map(c => ({
            filePath: c.entry.filePath,
            fileName: c.entry.fileName,
            caseCount: 0,
            items: [] as DeleteConfirmItem[],
            precheckError: c.stage === 'precheckFailed' ? c.precheckError : '未知',
        })),
    ];

    // P0-C1：若所有文件全部预检失败：跳过确认弹窗和真删阶段，
    // 直接走到 Step 10+11 用汇总面板展示所有跳过原因（与部分失败/全部成功走同款 panel）
    // 之前的实现：直接 showModal 弹阻断提示后 return，会造成"仅有此场景不走 panel"的 UI 割裂。
    const allPrecheckFailed = hardDeleteCtxs.length === 0 && needConfirmCtxs.length === 0;
    let confirmed = true;
    if (allPrecheckFailed) {
        // 全部预检失败：reopen 所有文件，跳过 Step 6-9（无需确认、无需真删/线上删除）
        for (const c of precheckFailedCtxs) {
            if (c.entry.wasOpen) await reopenCaseFile(c.entry.filePath);
        }
    } else {
        // Step 6: 弹聚合确认弹窗
        console.log('[workspaceListeners] 即将打开批量确认弹窗，batchEntries=', batchEntries.length,
            'items=', batchEntries.map(e => `${e.fileName}(cases=${e.caseCount},linked=${(e.items||[]).length},fail=${e.precheckError?'Y':'N'})`).join(' | '));
        confirmed = await showBatchDeleteConfirmModal(batchEntries);
        console.log('[workspaceListeners] 批量确认弹窗结束，confirmed=', confirmed);
    }

    if (!confirmed) {
        // 用户取消：全部保留原状
        for (const c of contexts) {
            if (c.entry.wasOpen) await reopenCaseFile(c.entry.filePath);
        }
        TelemetryService.sendTelemetryEvent('caseFileDelete.userCancel', {
            batch: 'true',
            fileCount: String(entries.length),
            precheckFailed: String(precheckFailedCtxs.length),
        });
        return;
    }

    // Step 7: 预检失败的文件：跳过删除、保留原状
    //   批量模式下不主动 reopen 编辑器（避免 tab 抖动 & 文件夹恢复卡顿），
    //   用户在汇总面板中点击该行时才通过 onOpenFile 打开。
    //   （单文件路径仍在 decideAndFinalizeCaseFileDelete 里保留 wasOpen ? reopen 的原体验。）

    // Step 8: 无需线上的文件：直接真删（不再逐个弹提示，结果并入汇总面板）
    const hardDeleteResults: PushFileResult[] = [];
    for (const c of hardDeleteCtxs) {
        if (c.stage !== 'hardDelete') continue;
        try {
            await finalizeHardDelete(c.entry.filePath);
            hardDeleteResults.push({
                filePath: c.entry.filePath,
                fileName: c.entry.fileName,
                successCount: c.rowCount,
                failCount: 0,
                total: c.rowCount,
                failures: [],
            });
        } catch (err: any) {
            console.error('[workspaceListeners] batch hardDelete 失败:', c.entry.fileName, err?.message || err);
            hardDeleteResults.push({
                filePath: c.entry.filePath,
                fileName: c.entry.fileName,
                successCount: 0,
                failCount: 0,
                total: c.rowCount,
                failures: [],
                error: err?.message || String(err) || '本地删除失败',
            });
        }
    }

    // Step 9: 需要线上删除的文件：串行执行同步 + 分派真删/覆写
    //   串行是为了避免瞬时并发大量线上请求 & 避免 panel reopen 竞态；
    //   批量模式下 finalize 不再 reopen 编辑器、不 postMessage，改为统一汇总；
    //   payloadSink 收集"打开文件后弹详情"所需的完整参数（供 onOpenFile 使用）。
    const detailPayloadSink = new Map<string, DeleteResultPayload>();
    const onlineResults: PushFileResult[] = [];
    for (const c of needConfirmCtxs) {
        if (c.stage !== 'needConfirm') continue;
        try {
            const r = await finalizeCaseFileAfterUserConfirm(c, /* batchMode */ true, detailPayloadSink);
            onlineResults.push(r);
        } catch (err: any) {
            console.error('[workspaceListeners] batch finalize 异常:', c.entry.fileName, err?.message || err);
            TelemetryService.sendTelemetryErrorEvent('caseFileDelete.decision.error', {
                errorMessage: String(err?.message || err).slice(0, 500),
                filePath: path.basename(c.entry.filePath),
            });
            onlineResults.push({
                filePath: c.entry.filePath,
                fileName: c.entry.fileName,
                successCount: 0,
                failCount: c.nonEmptyIds.length,
                total: c.nonEmptyIds.length,
                failures: c.nonEmptyIds.map(id => ({ tsId: id, reason: err?.message || String(err) || '决策异常' })),
                error: err?.message || String(err) || '决策异常',
            });
        }
    }

    // Step 10: 预检失败的文件也并入汇总面板（用 error 字段标记为"已跳过"），
    //   方便用户一站式看清"本批删除共处理了哪些文件、哪些真删、哪些保留原状"。
    const precheckReasonByPath = new Map<string, string>();
    const skippedResults: PushFileResult[] = precheckFailedCtxs.map(c => {
        const reason = (c.stage === 'precheckFailed' ? c.precheckError : '') || '未知';
        precheckReasonByPath.set(c.entry.filePath, reason);
        return {
            filePath: c.entry.filePath,
            fileName: c.entry.fileName,
            successCount: 0,
            failCount: 0,
            total: 0,
            failures: [],
            error: `已跳过（预检未通过）：${reason}`,
        };
    });

    // Step 11: 展示"批量删除结果"汇总面板（同批量推送样式，仅列出各文件结果，不展开失败明细）
    //   - 不主动打开任何文件，用户点击某行才通过 onOpenFile 打开；
    //   - 有 detailPayload（部分失败/整体异常）→ 走 presentDeleteResult 打开文件并弹详情弹窗；
    //   - 无 detailPayload 但文件存在（全成功的 hardDelete 分支不会存在）→ 直接打开；
    //   - 文件已被真删（hardDelete 场景）→ 提示"文件已删除"；
    //   - 预检失败 → 用 modal 展示预检原因，不打开文件。
    const allResults: PushFileResult[] = [...onlineResults, ...hardDeleteResults, ...skippedResults];
    if (allResults.length > 0) {
        const onOpenFile = async (result: PushFileResult) => {
            const fp = result.filePath;

            // 情况 1：预检失败 → 弹 modal 提示原因，不打开文件
            if (precheckReasonByPath.has(fp)) {
                showModal('default', 'warning', '此文件未被删除',
                    `${result.fileName}\n\n${precheckReasonByPath.get(fp)}`);
                return;
            }

            // 情况 2：文件已不存在（hardDelete 已真删 / 全部成功已真删）→ 提示"文件已删除"
            let fileExists = true;
            try { fileExists = fs.existsSync(fp); } catch (_) { fileExists = false; }
            if (!fileExists) {
                showModal('default', 'info', '文件已删除', `${result.fileName}\n\n该文件的所有案例均已从 TMS 平台删除。`);
                return;
            }

            // 情况 3：有详情载荷 → 先恢复失败行高亮，再弹详情弹窗
            //   1) openWith 打开文件（若未打开）+ 等 panel 就绪
            //   2) postMessage deleteRowsResult 恢复失败行高亮 + # 列 tooltip
            //   3) presentDeleteResult 弹详情弹窗（内部 getPanel 已就绪，不会重复打开）
            const payload = detailPayloadSink.get(fp);
            if (payload) {
                try {
                    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fp), TESTCASE_EDITOR_VIEWTYPE);
                } catch (_) { /* ignore */ }
                let panel = BaseEditorProvider.getPanel(fp);
                for (let i = 0; !panel && i < 30; i++) {
                    await new Promise(res => setTimeout(res, 100));
                    panel = BaseEditorProvider.getPanel(fp);
                }
                if (panel) {
                    try { await BaseEditorProvider.waitReady(fp, 3000); } catch (_) { /* ignore */ }
                    try {
                        const reasons: Array<[string, string]> = (payload.failures || [])
                            .map(f => [String(f.tsId), String(f.reason || '')]);
                        panel.webview.postMessage({
                            type: 'deleteRowsResult',
                            synced: (payload.syncedTsIds || []).map(String),
                            failed: (payload.failures || []).map(f => String(f.tsId)),
                            reasons,
                            deletedSuccess: payload.deletedSuccessIds || [],
                            deletedSourceMissing: payload.deletedSourceMissingIds || [],
                        });
                    } catch (_) { /* ignore */ }
                }
                await presentDeleteResult(payload);
                removeHighlightFile(fp).catch(() => {});
                return;
            }

            // 情况 4：兜底 —— 无 payload 但文件仍存在（理论上不会走到）→ 直接打开
            try {
                await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fp), TESTCASE_EDITOR_VIEWTYPE);
            } catch (_) { /* ignore */ }
        };

        // P1-C2：文件数为 1 时（极端场景，如 batchMode 走到单文件），标题去掉「批量」字样
        const _isSingle = allResults.length === 1;
        showPushSummary(allResults, onOpenFile, {
            panelTitle: _isSingle ? '删除结果' : '批量删除结果',
            documentTitle: _isSingle ? '删除结果' : '批量删除结果',
            headerTitle: '删除完成',
            // 不展开失败明细，用户点击文件行时通过 presentDeleteResult 查看详情
            showFailureDetails: false,
        });
    }
}

/**
 * 单文件的决策流程（N=1 时使用）：预检 → 弹确认 → syncDeletedRows → 真删 or 保留。
 *
 * 与批量路径共享同一套辅助函数（prepareCaseFileDecisionContext / finalizeCaseFileAfterUserConfirm），
 * 只是弹窗形态不同（单文件用 showDeleteConfirmSimpleModal / confirmCaseFileDeleteWithDetails）。
 *
 * 前提：文件已被 restoreCaseFile 拷回原路径。
 */
async function decideAndFinalizeCaseFileDelete(
    entry: WillBackupEntry,
    extContext: vscode.ExtensionContext,
): Promise<void> {
    const ctx = await prepareCaseFileDecisionContext(entry, extContext);

    // 预检失败：保留文件；改为与批量路径一致，走 pushSummary 汇总面板展示，
    // 避免"单文件走 modal、批量走 panel"的 UI 割裂（详见批量路径 P0-C1 决策）。
    // 用户点击面板中该行时才通过 onOpenFile 打开文件并弹 modal 展示预检原因。
    if (ctx.stage === 'precheckFailed') {
        if (entry.wasOpen) await reopenCaseFile(entry.filePath);
        const reason = ctx.precheckError || '未知';
        const result: PushFileResult = {
            filePath: entry.filePath,
            fileName: entry.fileName,
            successCount: 0,
            failCount: 0,
            total: 0,
            failures: [],
            error: `已跳过（预检未通过）：${reason}`,
        };
        const onOpenFile = async (r: PushFileResult) => {
            showModal('default', 'warning', '此文件未被删除',
                `${r.fileName}\n\n${reason}`);
        };
        showPushSummary([result], onOpenFile, {
            panelTitle: '删除结果',
            documentTitle: '删除结果',
            headerTitle: '删除完成',
            showFailureDetails: false,
        });
        return;
    }

    // 无需线上：直接真删
    if (ctx.stage === 'hardDelete') {
        await finalizeHardDelete(entry.filePath);
        return;
    }

    // 需要用户确认
    const { confirmItems, caseCountForConfirm } = ctx;
    const userConfirmed = confirmItems.length > 0
        ? await confirmCaseFileDeleteWithDetails(
            { filePath: entry.filePath, fileName: entry.fileName, caseCount: caseCountForConfirm, items: confirmItems },
        )
        : await showDeleteConfirmSimpleModal({ filePath: entry.filePath, fileName: entry.fileName, caseCount: caseCountForConfirm });

    if (!userConfirmed) {
        if (entry.wasOpen) await reopenCaseFile(entry.filePath);
        TelemetryService.sendTelemetryEvent('caseFileDelete.userCancel', {
            batch: 'false',
            filePath: path.basename(entry.filePath),
            caseCount: String(ctx.nonEmptyIds.length),
        });
        return;
    }

    await finalizeCaseFileAfterUserConfirm(ctx);
}

/**
 * 单文件"决策所需上下文"的联合类型。
 *
 * 三种终态：
 *   - hardDelete：无 testcase_id 列 / 空文件 / 全部本地未推送 → 无需线上，直接真删；
 *   - needConfirm：需要用户确认（可能是简单确认，也可能带 type=2 关联表格）；
 *   - precheckFailed：预检失败（未绑定任务 / 接口非成功 / 异常）→ 保留文件、弹阻断提示。
 */
type CaseFileDecisionContext =
    | {
        stage: 'hardDelete';
        entry: WillBackupEntry;
        rowCount: number;
    }
    | {
        stage: 'needConfirm';
        entry: WillBackupEntry;
        tableData: any;
        sourceData: any;
        rows: any[][];
        rowTsIds: string[];
        nonEmptyIds: string[];
        confirmItems: DeleteConfirmItem[];
        caseCountForConfirm: number;
    }
    | {
        stage: 'precheckFailed';
        entry: WillBackupEntry;
        precheckError: string;
    };

/**
 * 为单个案例文件准备"决策上下文"：
 *   parse（复用 will 阶段快照）→ 埋点 → 校验测试任务绑定 → 调预检接口。
 *
 * 该函数**不弹任何 UI、不做真删/覆写**，只负责把"是否需要用户确认、需要展示哪些关联案例"
 * 计算清楚，供批量聚合弹窗和单文件弹窗共用。
 */
async function prepareCaseFileDecisionContext(
    entry: WillBackupEntry,
    extContext: vscode.ExtensionContext,
): Promise<CaseFileDecisionContext> {
    const { filePath, fileName } = entry;

    // 优先复用 will 阶段 parse 出的 tableData
    let tableData = entry.restoreTableData;
    let sourceData = entry.restoreSourceData;
    if (!tableData) {
        const fileType = detectFileType(filePath);
        if (!fileType) {
            return { stage: 'precheckFailed', entry, precheckError: '无法识别文件类型' };
        }
        try {
            const parser = createParser(fileType);
            const parsed = await parser.parse(filePath);
            tableData = parsed.tableData;
            sourceData = parsed.sourceData;
        } catch (err: any) {
            console.warn('[workspaceListeners] 决策阶段 parse 失败:', fileName, err?.message || err);
            return { stage: 'precheckFailed', entry, precheckError: `文件解析失败：${err?.message || err}` };
        }
    }

    const headers: string[] = tableData?.headers || [];
    const rows: any[][] = tableData?.rows || [];
    const tsIdx = headers.indexOf(TS_ID_COLUMN);

    // 无 testcase_id 列 / 空文件：无需线上删除
    if (tsIdx < 0 || rows.length === 0) {
        TelemetryService.sendTelemetryEvent('caseFileDelete.intercept.init', {
            filePath: path.basename(filePath),
            totalRows: String(rows.length),
            hasTsId: 'false',
            nonEmptyIds: '0',
            artifactId: path.basename(filePath),
            testTaskNo: '',
            subTestTaskId: '',
            testcaseIds: '',
        });
        return { stage: 'hardDelete', entry, rowCount: rows.length };
    }

    const rowTsIds: string[] = rows.map(r => (r[tsIdx] == null ? '' : String(r[tsIdx]).trim()));
    const nonEmptyIds = rowTsIds.filter(Boolean);

    // 拉取测试任务信息（用于埋点 & 预检）
    const taskInfoResult = await resolveTaskInfoOrNull(filePath);
    let taskTestTaskNo = '';
    let taskSubTestTaskId = '';
    if (taskInfoResult.status === 'ok') {
        taskTestTaskNo = taskInfoResult.taskInfo.testTaskNo || '';
        taskSubTestTaskId = taskInfoResult.taskInfo.subTestTaskId || '';
    }

    TelemetryService.sendTelemetryEvent('caseFileDelete.intercept.init', {
        filePath: path.basename(filePath),
        totalRows: String(rows.length),
        hasTsId: 'true',
        nonEmptyIds: String(nonEmptyIds.length),
        artifactId: path.basename(filePath),
        testTaskNo: taskTestTaskNo,
        subTestTaskId: taskSubTestTaskId,
        testcaseIds: nonEmptyIds.join('|'),
    });

    // 全部本地未推送：无需调线上接口
    if (nonEmptyIds.length === 0) {
        return { stage: 'hardDelete', entry, rowCount: rows.length };
    }

    // 校验 1：未绑定测试任务 → 预检失败
    if (taskInfoResult.status !== 'ok') {
        const _errTxt = taskInfoResult.status === 'unbound'
            ? '当前文件未绑定测试任务，无法定位线上案例，请先绑定测试任务后再删除。'
            : (taskInfoResult.errorMessage || '获取测试任务信息失败');
        return { stage: 'precheckFailed', entry, precheckError: _errTxt };
    }

    // 校验 2：线上预检
    let confirmItems: DeleteConfirmItem[] = [];
    let caseCountForConfirm = nonEmptyIds.length;
    try {
        const resp = await confirmDeleteTestCase(extContext, taskInfoResult.taskInfo, nonEmptyIds);
        if (resp.returnCode === 'SUC0000' && Array.isArray(resp.body)) {
            const deletableCount = resp.body.filter(
                (it: any) => Number(it?.type) === 1 || Number(it?.type) === 2,
            ).length;
            confirmItems = resp.body
                .filter((it: any) => Number(it?.type) === 2)
                .flatMap((it: any) => {
                    const sid = String(it?.sourceId ?? '').trim();
                    const list = Array.isArray(it?.data) ? it.data : [];
                    return list.map((d: any) => ({
                        sourceId: String(d?.sourceId ?? sid).trim(),
                        testCaseNo: String(d?.testCaseNo ?? '').trim(),
                        testCaseName: String(d?.testCaseName ?? '').trim(),
                        hasExec: String(d?.hasExec ?? 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
                        hasBug: String(d?.hasBug ?? 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
                    }));
                })
                .filter((it: DeleteConfirmItem) => !!it.sourceId);
            caseCountForConfirm = deletableCount;
        } else {
            const rcPart = resp.returnCode
                ? `返回码：${resp.returnCode}，错误信息：${resp.errorMsg || '请稍后重试或联系管理员'}`
                : `错误信息：${resp.errorMsg || '请稍后重试或联系管理员'}`;
            return { stage: 'precheckFailed', entry, precheckError: rcPart };
        }
    } catch (ce: any) {
        const _errMsg = ce instanceof Error ? ce.message : String(ce || '');
        return { stage: 'precheckFailed', entry, precheckError: `删除确认接口调用失败：${_errMsg || '未知错误'}` };
    }

    return {
        stage: 'needConfirm',
        entry,
        tableData,
        sourceData,
        rows,
        rowTsIds,
        nonEmptyIds,
        confirmItems,
        caseCountForConfirm,
    };
}

/**
 * 批量删除结果详情载荷 —— 用户在汇总面板点击某文件时，
 * 用这份 payload 走 presentDeleteResult 弹出"该文件删除结果详情"，
 * 并借助 deletedSuccessIds / deletedSourceMissingIds 通过 postMessage 恢复失败行高亮。
 */
interface DeleteResultPayload {
    filePath: string;
    fileName: string;
    total: number;
    successCount: number;
    deletedSuccess: number;
    deletedSourceMissing: number;
    syncedTsIds: string[];
    failures: PushFailure[];
    needRestore: boolean;
    error?: string;
    /** 线上真实删除成功的 tsId 列表（type=1），用于批量场景 postMessage 恢复行状态 */
    deletedSuccessIds?: string[];
    /** 线上本不存在、已同步清理的 tsId 列表（type=3），用于批量场景 postMessage 恢复行状态 */
    deletedSourceMissingIds?: string[];
}

/**
 * "用户已确认删除"之后的执行流程：
 *   调 syncDeletedRows → 全部成功真删 / 部分失败覆写为"仅失败行" → 弹结果反馈。
 *
 * 该函数在批量路径和单文件路径下共用，前置逻辑（parse / 预检 / 弹窗）由上游负责。
 *
 * @param batchMode 批量模式：
 *   - false（默认，N=1 单文件路径）：保持原体验 —— reopen 编辑器 + 弹独立结果 modal；
 *   - true（N≥2 批量路径）：**不 reopen、不弹独立结果、不 panel.postMessage**，
 *     统一由上层用 showPushSummary 聚合展示，用户点击某行才打开文件；
 *     返回值提供逐文件的 PushFileResult 结构（复用批量推送汇总组件的类型）。
 * @param payloadSink 批量模式下的详情载荷收集器（可选）：
 *   若传入，则把该文件"打开后弹详情"所需的完整参数写入 map，
 *   由上层 onOpenFile 从中取出后调 presentDeleteResult 弹出详情弹窗。
 */
async function finalizeCaseFileAfterUserConfirm(
    ctx: Extract<CaseFileDecisionContext, { stage: 'needConfirm' }>,
    batchMode = false,
    payloadSink?: Map<string, DeleteResultPayload>,
): Promise<PushFileResult> {
    const { entry, tableData, sourceData, rows, rowTsIds, nonEmptyIds } = ctx;
    const { filePath, fileName, wasOpen } = entry;

    let syncResult: { synced: string[]; failed: Array<{ tsId: string; reason: string }>; deletedSuccess: string[]; deletedSourceMissing: string[] };
    try {
        syncResult = await syncDeletedRows(filePath, nonEmptyIds);
    } catch (err: any) {
        // 接口整体异常：保留文件、reopen、弹失败结果
        const idToRowIndex = new Map<string, number>();
        for (let i = 0; i < rows.length; i++) {
            const id = rowTsIds[i];
            if (id) idToRowIndex.set(id, i + 1);
        }
        const failures: PushFailure[] = nonEmptyIds.map(id => ({
            tsId: id,
            reason: err?.message ? String(err.message) : '删除接口调用失败',
            rowIndex: idToRowIndex.get(id),
        }));
        if (!batchMode) {
            if (wasOpen) await reopenCaseFile(filePath);
            await presentDeleteResult({
                filePath,
                fileName,
                total: nonEmptyIds.length,
                successCount: 0,
                deletedSuccess: 0,
                deletedSourceMissing: 0,
                syncedTsIds: [],
                failures,
                needRestore: true,
                error: err?.message || String(err),
            });
        } else if (payloadSink) {
            payloadSink.set(filePath, {
                filePath,
                fileName,
                total: nonEmptyIds.length,
                successCount: 0,
                deletedSuccess: 0,
                deletedSourceMissing: 0,
                syncedTsIds: [],
                failures,
                needRestore: true,
                error: err?.message || String(err),
            });
        }
        return {
            filePath,
            fileName,
            successCount: 0,
            failCount: failures.length,
            total: nonEmptyIds.length,
            failures,
            error: err?.message || String(err),
        };
    }

    // 分派：全部成功 → 真删；有失败 → 覆写为"仅失败行"
    const syncedSet = new Set(syncResult.synced.map(String));
    const failedMap = new Map(syncResult.failed.map(f => [String(f.tsId), String(f.reason || '线上删除失败')]));
    const failureTsIds = new Set(syncResult.failed.map(f => String(f.tsId)));

    const keepRows: any[][] = [];
    const keepSource: any[] = [];
    const failures: PushFailure[] = [];
    let successCount = 0;
    for (let i = 0; i < rows.length; i++) {
        const id = rowTsIds[i];
        if (id && syncedSet.has(id)) {
            successCount++;
            continue;
        }
        keepRows.push(rows[i]);
        if (Array.isArray(sourceData)) keepSource.push(sourceData[i]);
        if (id && failureTsIds.has(id)) {
            const reason = failedMap.get(id) || '线上删除失败';
            failures.push({ tsId: id, reason, rowIndex: keepRows.length });
        }
    }
    failures.sort((a, b) => {
        const ai = a.rowIndex == null ? Number.POSITIVE_INFINITY : a.rowIndex;
        const bi = b.rowIndex == null ? Number.POSITIVE_INFINITY : b.rowIndex;
        if (ai !== bi) return ai - bi;
        return String(a.tsId).localeCompare(String(b.tsId));
    });

    TelemetryService.sendTelemetryEvent('caseFileDelete.intercept.done', {
        total: String(nonEmptyIds.length),
        success: String(successCount),
        failed: String(failures.length),
        filePath: path.basename(filePath),
    });

    if (failures.length === 0) {
        // 全部成功 → 真删本地文件（关 tab、unlink、清理缓存、弹结果 modal）
        await finalizeHardDelete(filePath);
        if (!batchMode) {
            // P0-B1：与失败场景统一走 reportDeleteResult（同款 modal），
            // 复用 deletedSuccess / deletedSourceMissing 明细展示，避免"成功走 modal、
            // 失败走 panel/详情 modal"的 UI 割裂。
            // 说明：finalizeHardDelete 已关 tab，panel 已销毁，reportDeleteResult
            // 内部会走独立 modal 兜底（无 panel 场景），与预期一致。
            reportDeleteResult({
                panel: undefined,
                fileName,
                successCount,
                failures: [],
                total: nonEmptyIds.length,
                error: undefined,
                deletedSuccess: syncResult.deletedSuccess.length,
                deletedSourceMissing: syncResult.deletedSourceMissing.length,
            });
        }
        return {
            filePath,
            fileName,
            successCount,
            failCount: 0,
            total: nonEmptyIds.length,
            failures: [],
        };
    }

    // 有失败行 → 覆写为"仅失败行"版本 + reopen + 弹结果 modal
    const finalTableData = { ...tableData, rows: keepRows };
    const finalSourceData = Array.isArray(sourceData) ? keepSource : sourceData;
    try {
        const fileType = detectFileType(filePath);
        if (fileType) {
            const parser = createParser(fileType);
            await parser.save(filePath, finalTableData, finalSourceData);
        }
    } catch (saveErr: any) {
        console.error('[workspaceListeners] 覆写"仅失败行"失败（保留原文件）:', fileName, saveErr?.message || saveErr);
        TelemetryService.sendTelemetryErrorEvent('caseFileDelete.saveFailedRowsError', {
            errorMessage: String(saveErr?.message || saveErr).slice(0, 500),
            filePath: path.basename(filePath),
        });
    }

    if (!batchMode) {
        if (wasOpen) {
            await reopenCaseFile(filePath);
        }

        // 回传 deleteRowsResult 到 panel（渲染失败行高亮 + # 列 tooltip）
        const panel = BaseEditorProvider.getPanel(filePath);
        if (panel) {
            const reasons: Array<[string, string]> = failures.map(f => [String(f.tsId), String(f.reason || '')]);
            try {
                panel.webview.postMessage({
                    type: 'deleteRowsResult',
                    synced: Array.from(syncedSet).map(String),
                    failed: failures.map(f => String(f.tsId)),
                    reasons,
                    deletedSuccess: syncResult.deletedSuccess,
                    deletedSourceMissing: syncResult.deletedSourceMissing,
                });
            } catch (_) { /* ignore */ }
        }

        await presentDeleteResult({
            filePath,
            fileName,
            total: nonEmptyIds.length,
            successCount,
            deletedSuccess: syncResult.deletedSuccess.length,
            deletedSourceMissing: syncResult.deletedSourceMissing.length,
            syncedTsIds: Array.from(syncedSet),
            failures,
            needRestore: true,
            error: undefined,
        });
        // 失败行仍在文件中，仅清理临时态高亮
        removeHighlightFile(filePath).catch(() => {});
    } else if (payloadSink) {
        payloadSink.set(filePath, {
            filePath,
            fileName,
            total: nonEmptyIds.length,
            successCount,
            deletedSuccess: syncResult.deletedSuccess.length,
            deletedSourceMissing: syncResult.deletedSourceMissing.length,
            syncedTsIds: Array.from(syncedSet),
            failures,
            needRestore: true,
            error: undefined,
            deletedSuccessIds: syncResult.deletedSuccess.map(String),
            deletedSourceMissingIds: syncResult.deletedSourceMissing.map(String),
        });
    }

    return {
        filePath,
        fileName,
        successCount,
        failCount: failures.length,
        total: nonEmptyIds.length,
        failures,
    };
}

/**
 * 真删本地文件：关闭 tab（若已开）→ unlink → 清理缓存/绑定库。
 * 仅在"全部同步成功"或"文件本就无需线上操作"路径调用。
 */
async function finalizeHardDelete(filePath: string): Promise<void> {
    try {
        // 关闭已打开的案例编辑器 tab（若有）：用 revert + close 保底
        const panel = BaseEditorProvider.getPanel(filePath);
        if (panel) {
            try { panel.dispose(); } catch { /* ignore */ }
        }
    } catch (_) { /* ignore */ }

    // 主动 unlink
    let unlinkErr: any = null;
    try {
        await fs.promises.unlink(filePath);
    } catch (err: any) {
        // 文件可能已不存在（并发场景）：忽略 ENOENT（等价于删除成功）
        if (err?.code !== 'ENOENT') {
            unlinkErr = err;
            console.warn('[workspaceListeners] finalizeHardDelete unlink 失败:', path.basename(filePath), err?.message || err);
        }
    }

    // 清理插件侧的缓存/结定/高亮（无论 unlink 是否成功都经过清理，避免脏数据残留）
    try { await cleanupCaseFileTraces(filePath); } catch (_) { /* ignore */ }

    // 将非 ENOENT 的 unlink 失败报告给上层，避免静默失败导致“提示删除成功但本地文件仍存在”
    if (unlinkErr) {
        throw unlinkErr;
    }
}

/**
 * did 阶段的立即拷回：把 will 阶段备份好的文件恢复到原路径。
 *
 * 三级降级依次尝试：
 *   1. backupPath（磁盘备份，含 copyFileSync 与 parser 序列化两类）→ fs.copyFile 覆盖回原路径；
 *   2. restoreTableData 内存快照 → parser.save 兜底重建；
 *   3. 都没有 → 什么都不做（文件真丢，仅上报埋点）。
 *
 * 拷回后：
 *   - 磁盘备份使用完毕后 unlink；
 *   - 上报 caseFileDelete.restore.done（区分 backup / backupSerialized / parser / none）。
 */
async function restoreCaseFile(entry: WillBackupEntry): Promise<void> {
    const { filePath, backupPath, backupPathIsSerialized, restoreTableData, restoreSourceData } = entry;

    // 文件夹删除场景下父目录也会被 VSCode 递归 unlink，拷回前必须先 mkdir -p 恢复目录树；
    // 单文件删除时父目录仍存在，mkdir { recursive:true } 是 no-op，不会破坏原目录。
    try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    } catch (mkErr: any) {
        console.warn('[workspaceListeners] restore mkdir 父目录失败（继续尝试拷回）:', path.basename(filePath), mkErr?.message || mkErr);
    }

    // 一级：磁盘备份
    if (backupPath && fs.existsSync(backupPath)) {
        try {
            await fs.promises.copyFile(backupPath, filePath);
            try { await fs.promises.unlink(backupPath); } catch { /* ignore */ }
            TelemetryService.sendTelemetryEvent('caseFileDelete.restore.done', {
                filePath: path.basename(filePath),
                via: backupPathIsSerialized ? 'backupSerialized' : 'backup',
            });
            return;
        } catch (err: any) {
            console.warn('[workspaceListeners] restore 一级降级 copyFile 失败:', path.basename(filePath), err?.message || err);
            // 继续走二级
        }
    }

    // 二级：parser.save 兜底
    if (restoreTableData) {
        const fileType = detectFileType(filePath);
        if (fileType) {
            const parser = createParser(fileType);
            await parser.save(filePath, restoreTableData, restoreSourceData);
            TelemetryService.sendTelemetryEvent('caseFileDelete.restore.done', {
                filePath: path.basename(filePath),
                via: 'parser',
            });
            return;
        }
    }

    // 三级：无解
    TelemetryService.sendTelemetryErrorEvent('caseFileDelete.restore.giveup', {
        filePath: path.basename(filePath),
        hasBackup: String(!!backupPath),
        hasTableData: String(!!restoreTableData),
    });
}

/**
 * 以案例编辑器重新打开文件（仅在"保留文件"路径调用）。
 * 非阻塞、失败静默。
 */
async function reopenCaseFile(filePath: string): Promise<void> {
    try {
        const uri = vscode.Uri.file(filePath);
        await vscode.commands.executeCommand('vscode.openWith', uri, TESTCASE_EDITOR_VIEWTYPE);
        TelemetryService.sendTelemetryEvent('caseFileDelete.reopen', {
            filePath: path.basename(filePath),
        });
    } catch (err: any) {
        console.warn('[workspaceListeners] 重建后重开文件失败（已忽略）:', err?.message || err);
    }
}

/**
 * 弹出"删除结果"反馈（部分成功 / 全部失败）。
 *
 * 文件已被"仅失败行"版本覆写、tab 已 reopen → 优先走 panel 内 postMessage；
 * panel 缺失时降级为独立 webview modal。
 */
async function presentDeleteResult(r: {
    filePath: string;
    fileName: string;
    total: number;
    successCount: number;
    deletedSuccess: number;
    deletedSourceMissing: number;
    syncedTsIds: string[];
    failures: PushFailure[];
    needRestore: boolean;
    error?: string;
}): Promise<void> {
    try {
        let panel = BaseEditorProvider.getPanel(r.filePath);
        if (!panel && r.needRestore) {
            // panel 尚未注册 → 再试一次打开
            try {
                await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(r.filePath), TESTCASE_EDITOR_VIEWTYPE);
            } catch (_) { /* ignore */ }
            for (let i = 0; i < 30; i++) {
                await new Promise(res => setTimeout(res, 100));
                panel = BaseEditorProvider.getPanel(r.filePath);
                if (panel) break;
            }
        }
        if (panel) {
            try {
                await BaseEditorProvider.waitReady(r.filePath, 3000);
            } catch (_) { /* ignore */ }
        }
        reportDeleteResult({
            panel,
            fileName: r.fileName,
            successCount: r.successCount,
            failures: r.failures,
            total: r.total,
            error: r.error,
            deletedSuccess: r.deletedSuccess,
            deletedSourceMissing: r.deletedSourceMissing,
        });
    } catch (err: any) {
        console.warn('[workspaceListeners] 弹出删除结果失败:', err?.message || err);
        try {
            showModal('default', 'error', '删除结果',
                `删除结果反馈异常：${r.fileName}\n\n${err?.message || err || '未知错误'}`);
        } catch (_) { /* ignore */ }
    }
}