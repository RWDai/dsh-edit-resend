# dsh-edit-resend

DSH 插件：**编辑历史用户消息并从该处重跑**——在对话里任意一条你发过的消息上点「编辑并重跑」，改完文本确认，它会从那条消息处 fork 出一个新会话并重跑。之前的上下文一字不动，**供应商侧的 prompt cache 能原样命中**。

## 它是怎么工作的

DSH 的会话日志是 append-only 事件流，已入账的 `user/message` 改不了。但宿主提供两块可组合的原语，这个插件把它们串起来：

1. **`session.fork`（精确前缀 fork）**——`sessions.fork({ sessionId, atSeq })` 从源会话复制一个事件前缀（含 `atSeq`）出子会话。前缀内的事件逐字节复用；如果切点落在未闭合的 turn 里，host 侧会补合成收尾事件。于是**子会话边界之前的模型可见历史与原会话完全一致**——这正是缓存命中的条件。
2. **会话 binding 的 `prompt`**——fork 出的子会话必然空闲，直接把编辑后的文本作为第一条新消息发进去（`queue` 模式 = 立即开跑）。

发完自动导航到子会话。原会话原样保留，分支历史天然可追溯（子会话带 `parentSessionId`，标题在原标题后加序号）。

## 使用

- 任何一条**你发出的、已入账的**用户消息下方会出现一枚铅笔按钮（悬停消息行可见），本地回显、steering、注入上下文不出按钮。
- 点击进入编辑浮层：原文本已填好，`Ctrl/Cmd+Enter` 确认，`Esc` 关闭。
- 消息带图片/附件时也能编辑，但**重发只包含文本部分**，浮层里会说明。
- 按钮受权限约束：需要 `session/fork` 与 `session/prompt` 两项都可用。

## 安装

装进 [dsh-rwdai-bundle](../../README.md)（已作为 bundle 的一部分自动插入），或单独添加：

```
link:/storage/heletian/dsh-rwdai-bundle/packages/dsh-edit-resend
```

## 结构

```
dsh-edit-resend/
  cordis.patch.yml     bundle 装配行（id: edit-resend）
  lib/index.js         host 半：仅 /plugin/dsh-edit-resend/health 健康检查
  lib/client.js        浏览器半：用户消息渲染器覆盖 + 编辑浮层 + fork&resend
  locale/*.json        zh/en 文案
```

浏览器半覆盖 `conversation.chat.node` 插槽的 `user` 键（keyed 插槽同格按 priority 升序取第一个渲染，动态注册分到负数 priority，稳定压过内置视图），只增强不破坏：文本用公开原语 `MarkdownText` 重绘，视觉对齐官方气泡。

## 注意

- 缓存命中以供应商实际行为为准：前缀逐字节一致是必要条件，TTL、配额、供应商侧是否按前缀计费由它自己决定。fork 本身不产生模型请求，重发的那一条才是新请求。
- fork 是**新会话**：原会话的未读、钉选等状态不跟随；子会话继承工作区（workspace）与 cwd。
- 与官方「分支」按钮（turn 尾部的 fork）的区别：那个从 turn 结束处复制，不带新消息；这个在**你指定的用户消息**处切，并立刻以编辑后的文本重跑。

## 兼容性

0.1.1 修复了一处会让 **web 整体起不来**的激活错误，升级务必覆盖旧版。

动态插件拿到的 `ctx` 是受守卫的代理：读取任何没有写进 `exports.inject` 的服务都会直接抛错，并被记为包激活失败。0.1.0 在 `apply` 里读了 `ctx.uiWorkspace` 却没声明它，于是插件在激活阶段就抛错，页面随之白屏。0.1.1 的修法：

```js
exports.inject = ["slots", "locale", "sessions", "uiWorkspace"];
```

同一次修复还纠正了两处 API 误用（0.1.0 里功能其实也跑不通）：

- `binding(id)` 的返回值**没有** `prompt`。fork 只把子会话写进目录、不持有引用，而 `binding()` 对没有活跃引用的世代返回 `undefined`。正确顺序是 `retain` → 等 `reference.ready` → `binding.session.prompt(...)`。
- `useSessions` 是**选择器 hook**（`SnapshotSelectorHook`），不是服务本体；服务走 `ctx.sessions`。组件里真正可用的是标准 prop `useAccess`（权限查询）。

