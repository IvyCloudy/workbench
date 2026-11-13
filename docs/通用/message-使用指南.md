# message.ts 公共弹窗使用指南

## 概述

`src/utils/message.ts` 是插件**唯一的弹窗入口**，封装了 7 个公共方法，覆盖所有提示场景。

**核心机制**：`panel` 可用时通过 `postMessage` 发往现有 webview 前端渲染；`panel` 不可用时自动创建独立 webview 面板渲染同款样式，关闭后自动销毁。

---

## 类型定义

```ts
/** 弹窗类型 */
type MsgType = 'success' | 'error' | 'warning' | 'info';

/** 推送失败条目 */
interface PushFailure {
    tsId: string;    // 测试案例 TS-ID
    reason: string;  // 失败原因
    rowIndex?: number;
}
```

---

## 方法 1：`showModal` —— 通用模态框

最常用的弹窗方法，支持 4 种类型。

### 签名

```ts
showModal(
    panel: vscode.WebviewPanel | undefined | 'default',
    modalType: MsgType,
    title: string,
    message: string,
    fileName?: string
): void
```

### 使用示例

```ts
import { showModal } from '../utils/message';

// 成功 — 绿色图标 ✓
showModal(panel, 'success', '保存成功', '文件已保存到远端。');

// 错误 — 红色图标 ✕
showModal(panel, 'error', '操作失败', '后端返回: 参数校验失败，请检查输入。', baseName);

// 警告 — 黄色图标 !
showModal(panel, 'warning', '注意', '部分行数据格式异常，已自动跳过。');

// 信息 — 蓝色图标 i
showModal(panel, 'info', '提示', '绑定配置已更新，下次推送生效。');
```

### panel 参数说明

| 值 | 行为 |
|----|------|
| `panel` (WebviewPanel) | 发送 `showModal` 消息给现有 webview 前端渲染 |
| `'default'` | 创建独立的 webview 面板渲染模态框，关闭时自动 `dispose()` |
| `undefined` | 等同 `'default'` |

```ts
// 无 webview 场景
showModal('default', 'warning', '多文件推送', '暂不支持多文件推送，请逐个推送。');

// 有 webview 场景
showModal(this.panel, 'error', '任务解析', r.error);
```

### 交互行为

- **关闭方式**：确定按钮 / ✕ 按钮 / 遮罩层点击 / ESC 键
- **独立面板**关闭后自动调用 `dispose()` 回收资源

---

## 方法 2：`showToast` —— 轻量 Toast

用于短暂的非阻塞提示，panel 内以底部 Toast 形式 2 秒自动消失。

### 签名

```ts
showToast(
    panel: vscode.WebviewPanel | undefined,
    toastType: MsgType,
    message: string
): void
```

### 使用示例

```ts
import { showToast } from '../utils/message';

showToast(this.panel, 'success', '数据发送成功');
showToast(this.panel, 'error', '发送失败，请重试');
showToast(this.panel, 'warning', '请先勾选要发送的数据');
```

> **注意**：无 panel 时回退到 `showModal('default', ...)` 模态框。

---

## 方法 3：`showPushErrorModal` —— 推送错误弹窗

推送流程中的校验/后端报错专用，兼容现有 `pushResult` 消息类型。

### 签名

```ts
showPushErrorModal(
    panel: vscode.WebviewPanel | undefined,
    fileName: string,
    errorText: string
): void
```

### 使用示例

```ts
import { showPushErrorModal } from '../utils/message';

showPushErrorModal(panel, baseName, '未绑定任务，无法推送文件。');
showPushErrorModal(panel, baseName, '后端返回: 案例编号重复，推送终止。');
```

---

## 方法 4：`showPushResult` —— 推送结果汇总

推送完成后展示成功/失败统计，自动按结果类型（全成功/部分成功/全失败）选择颜色和内容。

### 签名

```ts
showPushResult(
    panel: vscode.WebviewPanel | undefined,
    fileName: string,
    successCount: number,
    failures: PushFailure[],
    total: number
): void
```

### 使用示例

```ts
import { showPushResult, PushFailure } from '../utils/message';

const failures: PushFailure[] = [
    { tsId: 'TS-001', reason: '参数校验失败', rowIndex: 3 },
    { tsId: 'TS-005', reason: '案例编号重复', rowIndex: 7 },
];

showPushResult(panel, 'testcases.csv', 8, failures, 10);
// → 部分成功弹窗：成功 8 / 失败 2 / 共 10 条，展示失败明细
```

---

## 方法 5：`showSaveResult` —— 保存结果

编辑器保存操作的反馈。

### 签名

```ts
showSaveResult(
    panel: vscode.WebviewPanel | undefined,
    success: boolean,
    errorMessage?: string
): void
```

### 使用示例

```ts
import { showSaveResult } from '../utils/message';

// 保存成功 — 前端接收 'saved' 消息后清除修改集、重渲染
showSaveResult(webviewPanel, true);

// 保存失败 — 前端接收 'saveError' 消息后展示错误 toast
showSaveResult(webviewPanel, false, '文件已被外部修改，保存失败。');
```

---

## 方法 6：`showPushDone` —— 推送完成通知

推送流程结束信号，用于解锁前端的推送按钮 loading 状态。

### 签名

```ts
showPushDone(panel: vscode.WebviewPanel | undefined): void
```

### 使用示例

```ts
import { showPushDone } from '../utils/message';

// 推送结果和完成通知通常连续调用
showPushResult(webviewPanel, fileName, ok, fails, total);
showPushDone(webviewPanel);
```

> 无 panel 时不产生任何提示（仅 panel 内有效）。

---

## 方法 7：`showConnectionError` —— 连接错误（带操作按钮）

后端连接失败时的专用弹窗，嵌入了"打开配置"和"查看帮助"两个操作按钮。

### 签名

```ts
showConnectionError(
    _panel: vscode.WebviewPanel | undefined,
    typeLabel: string,
    errMsg: string
): Promise<void>
```

### 使用示例

```ts
import { showConnectionError } from '../utils/message';

await showConnectionError(panel, 'CSV编辑器', '连接后端超时，请检查网络或服务状态。');
```

### 操作按钮行为

| 按钮 | 行为 |
|------|------|
| 打开配置 | 执行 `workbench.action.openSettings` 跳转到 `testcaseViewer.apiUrl` 配置项 |
| 查看帮助 | 弹出帮助信息模态框（Mock 服务启动指引） |
| 确定 / ✕ / 遮罩层 | 关闭弹窗 |

---

## 完整使用场景参考

```ts
import {
    showModal, showToast,
    showPushErrorModal, showPushResult, showPushDone,
    showSaveResult, showConnectionError,
} from '../utils/message';

// 1) 校验类提示 — showModal
if (!isValid) {
    showModal(panel, 'warning', '格式校验', '第 5 行包含未闭合的引号，已跳过。');
    return;
}

// 2) 操作反馈 — showToast
showToast(panel, 'success', '文件导入成功');

// 3) 推送流程
try {
    const result = await pushTestCases(data);
    showPushResult(panel, 'testcases.csv', result.ok, result.failures, result.total);
    showPushDone(panel);
} catch (err) {
    const msg = err.message || '未知错误';
    if (/连接.*超时|ECONNREFUSED/.test(msg)) {
        await showConnectionError(panel, 'CSV编辑器', msg);
    } else {
        showPushErrorModal(panel, 'testcases.csv', msg);
    }
}

// 4) 保存操作
try {
    await saveFile(data);
    showSaveResult(panel, true);
} catch (err) {
    showSaveResult(panel, false, err.message);
}
```

---

## 消息类型速查

| 方法 | webview postMessage type | 前端需监听 |
|------|-------------------------|-----------|
| `showModal` | `showModal` | ✅ 需实现 |
| `showToast` | `showToast` | ✅ 需实现 |
| `showPushErrorModal` | `pushResult`（含 `error` 字段） | ✅ 已实现 |
| `showPushResult` | `pushResult` | ✅ 已实现 |
| `showSaveResult` | `saved` / `saveError` | ✅ 已实现 |
| `showPushDone` | `pushDone` | ✅ 已实现 |
| `showConnectionError` | 独立面板 | — |

> `showModal` 和 `showToast` 发送的是新 message type，前端需新增对应的 handler 和模态框/Toast 渲染逻辑。其余 5 个方法前端已有现成处理。
