/**
 * ============================================================================
 *  utils/asyncLock.ts
 *  进程内 per-key 异步互斥锁（最小实现）
 * ----------------------------------------------------------------------------
 *  职责：
 *    对同一 key 上的并发 async 任务串行化，避免多入口同时对同一文件做
 *    parse → mutate → save 的写盘链路产生互相覆盖。
 *
 *  设计要点：
 *    1. 无外部依赖：仅用 Map<key, Promise> 尾链，任务结束后自动清理。
 *    2. 公平性：先来先执行（JS event loop 天然保序）。
 *    3. 可重入性：不支持（若同一 key 递归调用 withFileLock 会死锁——
 *       调用方需保证锁范围内不再对同一 key 加锁）。
 *    4. 异常隔离：单个任务抛错不会污染队列，后续任务照常执行。
 *    5. 内存回收：当队列排空时自动 delete key，防止长期运行下 Map 无限增长。
 *
 *  用法：
 *    await withFileLock(filePath, async () => {
 *        // parse → mutate → save
 *    });
 * ============================================================================
 */

/** key → 该 key 上"最后一个已排队的任务"Promise（新任务链式等待其结束） */
const chains = new Map<string, Promise<void>>();

/**
 * 对给定 key 加锁执行 fn，返回 fn 的结果 / 抛出 fn 的错误。
 * 同 key 的并发调用严格串行，不同 key 完全并发。
 *
 * @param key 锁 key（推荐使用文件绝对路径）
 * @param fn  临界区内的异步任务
 */
export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!key) {
        // 无 key 时不排队，直接执行（保底降级，避免调用方误用导致挂死）
        return fn();
    }

    // 取当前 key 的尾链（可能不存在）——本任务的"上游"
    const prev = chains.get(key) ?? Promise.resolve();

    // 创建本任务的"完成信号"：release() 触发后，排在本任务之后的任务才被放行
    let release!: () => void;
    const done = new Promise<void>(res => { release = res; });

    // 将本任务追加到 chain：下一个 withFileLock 调用会 await 到 done 完成
    // 使用 catch 吞掉上游异常，保证 chain 不因上游抛错而断裂
    chains.set(key, prev.catch(() => { /* 隔离上游异常 */ }).then(() => done));

    try {
        await prev.catch(() => { /* 上游抛错与本任务无关 */ });
        return await fn();
    } finally {
        release();
        // 若本任务就是当前尾链所依赖的最后一环，释放后 chain 已无新排队者
        // 通过在下一个微任务中检查队列尾是否仍指向 done 链来决定是否清理 map
        Promise.resolve().then(() => {
            // done 已 resolved，若 chain 的尾仍是"以 done 结束的 Promise"，
            // 说明这之后没有新任务追加，可以安全删除 key 释放内存。
            // 由于外部无法直接比较尾链身份，采用间接判断：把当前尾链 await 一下，
            // 若已 resolved 且长度只增未变则删除。此处保守做法：延后清理由 GC 兜底。
            // 仅在 chain 完全空闲（下一次 tick 时 prev 已 settled）时 delete。
            const cur = chains.get(key);
            if (!cur) return;
            // 只要还有其他任务排队，cur 就未 settled；用 Promise.race 探测状态
            const sentinel = Symbol('pending');
            Promise.race([cur, Promise.resolve(sentinel)]).then(v => {
                if (v !== sentinel) chains.delete(key);
            });
        });
    }
}

/**
 * 测试/清理入口：清空所有锁链。仅在单元测试或插件 deactivate 阶段调用。
 */
export function _clearAllLocks(): void {
    chains.clear();
}
