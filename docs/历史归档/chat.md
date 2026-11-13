## VS Code 提供了 Chat API 来实现

插件**可以**触发打开聊天助手并发送消息，具体取决于你使用的 VS Code 版本和想要的目标聊天对象。

---

### 1. 打开 VS Code 内置 Chat 面板（1.86+）

使用 `workbench.action.chat.open` 命令，传入 `query` 参数可以预填消息：

```typescript
// 打开 Chat 面板并预填消息
vscode.commands.executeCommand('workbench.action.chat.open', {
    query: '请帮我解释这段代码',
    isPartialQuery: false  // false = 自动发送，true = 只填入不发送
});
```

关键参数：
- **`query`**: 要发送的消息文本
- **`isPartialQuery`**: `true` 则只填入输入框等待用户确认；`false` 则自动发送

---

### 2. 使用 Chat 参与者（如 `@workspace`）

```typescript
vscode.commands.executeCommand('workbench.action.chat.open', {
    query: '@workspace 这段代码有什么问题？',
    isPartialQuery: true  // 填入输入框让用户确认后再发送
});
```

---

### 3. 注册自定义 Chat Participant（1.85+）

你的插件也可以作为一个 Chat 参与者，响应用户在聊天中的请求：

```typescript
// 在 activate() 中注册
const participant = vscode.chat.createChatParticipant('testcase-viewer', async (request, context, stream, token) => {
    // request.prompt - 用户的问题
    // stream.markdown() - 发送 Markdown 回复
    stream.markdown('收到你的问题：' + request.prompt);
});

participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
```

---

### 4. 聚焦到 Chat 面板

```typescript
// 仅仅聚焦到 Chat 面板
vscode.commands.executeCommand('workbench.action.chat.focus');
```

---

### 实际示例：在你的插件中集成

在你的 `extension.ts` 中注册一个命令：

```typescript
vscode.commands.registerCommand('testcaseViewer.askChatAssistant', async () => {
    const editor = vscode.window.activeTextEditor;
    const selectedText = editor?.document.getText(editor.selection) || '';

    await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `请帮我分析这段测试案例：\n${selectedText}`,
        isPartialQuery: true  // 让用户确认后发送
    });
});
```

然后在 `package.json` 中声明命令即可。

---

### ⚠️ 注意事项

| 项目 | 说明 |
|------|------|
| **VS Code 版本** | 至少 **1.86+** 支持 `query` 参数 |
| **Chat 扩展依赖** | 需要用户安装了 Chat 参与者（如 GitHub Copilot Chat） |
| **`isPartialQuery`** | 建议设为 `true`，让用户确认后再发送，体验更好 |
| **`@` 参与者** | 消息中可以用 `@workspace`、`@terminal` 等指定参与者 |
