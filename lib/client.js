/**
 * dsh-edit-resend —— 浏览器半。
 *
 * 「编辑历史用户消息并从该处重跑」。DSH 的会话日志是 append-only 事件流，已
 * 入账的 user/message 改不了；但它提供了两块可以组合的原语：
 *
 *   1. `sessions.fork` —— 从一个精确事件前缀（atSeq，含）复制出子会话。前缀内
 *      的事件逐字节复用，未闭合的 turn 由 host 补合成收尾。于是「边界之前的
 *      模型可见历史」与原会话完全一致 —— 供应商侧的 prompt cache 能原样命中。
 *   2. 《会话 face》的 `session.prompt` —— 向子会话直接发一条新的用户消息（绕过
 *      输入框，不经过草稿/命令面）。binding 本身不带 prompt：fork 出的子会话先
 *      `retain`，等 `reference.ready` 落定后经 `binding.session.prompt` 发送。
 *
 * 两者串起来就是「编辑重跑」：在某条用户消息处取边界（用它的 seq），fork，
 * 然后把编辑后的文本作为第一条新消息发进子会话，最后导航过去。原会话不动，
 * 天然是分支历史。
 *
 * UI 挂点：
 *   - `conversation.chat.node` 的 `user` 键 —— 覆盖内置用户消息渲染器。keyed
 *     插槽同格按 priority 升序取第一个渲染；动态包注册的 priority 由运行时统一
 *     分配（唯一且低于内置），无需自己填。
 *   - 编辑浮层是本插件自绘的（overlay + textarea），只用公开原语。
 *
 * 服务与 props：
 *   - 根级服务 `sessions` / `uiWorkspace`（连同 `slots` / `locale`）都写在
 *     `exports.inject` 里。动态插件的 ctx 是被守卫的代理：**读未声明的服务会
 *     直接抛错，并被记为包激活失败**（早期版本正是这样把 web 一起带崩的）。
 *   - 组件标准 props：`sessionId`（会话作用域自动携带）、`useAccess`（权限
 *     查询）、`loadImage`。注意 `useSessions` 是选择器 hook，不是服务本体。
 *
 * 两条硬约束：
 *   - 只对 source.kind === 'user' 的 durable 消息提供编辑（steering、注入上
 *     下文、本地回显不是可编辑的历史）。
 *   - fork+发送需要 `session/fork` 与 `session/prompt` 两项访问权限，缺一不
 *     出按钮。
 */
window.__ModuleLoader__.load({
	id: "dsh-edit-resend",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** 文案命名空间（字典在文件尾，经 ctx.locale.register 注册兜底）。 */
		const NS = "dshEditResend";

		//#region 样式
		const CSS = [
			".dshER_host{flex-direction:column;align-items:flex-end;gap:6px;display:flex}",
			".dshER_stack{min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);flex-direction:column;align-items:flex-end;gap:8px;display:flex}",
			".dshER_bubble{background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl);max-width:100%;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);word-break:break-word;padding:10px 16px}",
			".dshER_actions{height:calc(28px + var(--dsh-content-font-delta,0px));align-items:center;gap:8px;display:flex}",
			".dshER_action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}",
			".dshER_action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}",
			".dshER_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dshER_overlay{position:fixed;inset:0;z-index:80;background:color-mix(in srgb, #000 45%, transparent);display:flex;align-items:center;justify-content:center}",
			".dshER_panel{width:min(560px,calc(100vw - 48px));border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsh-elevation-panel,0 8px 32px #0006);padding:16px 18px;display:flex;flex-direction:column;gap:10px}",
			".dshER_title{font:var(--dsw-font-md-strong-14);color:var(--dsw-alias-label-primary)}",
			".dshER_hint{font:var(--dsw-font-xs-12);line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".dshER_textarea{width:100%;box-sizing:border-box;min-height:96px;max-height:40vh;resize:vertical;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-0);color:var(--dsw-alias-label-primary);font:var(--dsw-font-sm-13);line-height:1.5;padding:8px 10px}",
			".dshER_textarea:focus{outline:none;border-color:var(--dsw-alias-border-l4)}",
			".dshER_error{font:var(--dsw-font-xs-12);color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}",
			".dshER_row{display:flex;justify-content:flex-end;gap:8px;align-items:center}",
			".dshER_btn{border-radius:var(--dsw-radius-sm);cursor:pointer;border:none;padding:6px 14px;font:var(--dsw-font-sm-strong-13)}",
			".dshER_btn[disabled]{cursor:default;opacity:.6}",
			".dshER_btnGhost{background:0 0;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2)}",
			".dshER_btnGhost:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dshER_btnPrimary{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-invert,#fff)}",
			".dshER_btnPrimary:hover{filter:brightness(1.05)}"
		].join("");
		function installStyles() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-edit-resend/styles";
			if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-edit-resend";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region 纯函数
		/**
		 * 从消息内容块里取纯文本（图片/文件/其它块不参与）。
		 * @param {readonly unknown[]} content 消息内容块。
		 * @returns {string} 文本块拼接。
		 */
		function textOf(content) {
			let out = "";
			for (const block of content ?? []) {
				if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") out += block.text;
			}
			return out;
		}

		/**
		 * 消息是否携带非文本块（编辑浮层里要提示「只重发文本部分」）。
		 * @param {readonly unknown[]} content 消息内容块。
		 * @returns {boolean} 有非文本块时为真。
		 */
		function hasNonText(content) {
			return (content ?? []).some((block) => !(block !== null && typeof block === "object" && block.type === "text"));
		}

		/**
		 * 这条 Chat 节点是否可编辑：durable 的 user 消息（不是本地回显/steering/
		 * 注入上下文），且带着真实的事件 seq。
		 * @param {{kind: string, seq?: number, source?: unknown}} data 节点数据。
		 * @returns {boolean} 可编辑时为真。
		 */
		function editable(data) {
			return data.kind === "user"
				&& typeof data.seq === "number"
				&& data.source !== null && typeof data.source === "object"
				&& data.source.kind === "user";
		}
		//#endregion

		//#region 编辑浮层
		/**
		 * 编辑浮层。打开时填入原文本；确认走 fork+resend，失败把错误留在浮层里，
		 * 成功由父级随会话切换卸载本组件。
		 * @param {object} props 组件属性。
		 * @param {string} props.initialText 原消息文本。
		 * @param {boolean} props.nonText 是否携带非文本块。
		 * @param {(text: string) => Promise<void>} props.onSubmit 确认回调（抛错=失败）。
		 * @param {() => void} props.onClose 关闭回调。
		 * @param {(key: string, params?: Record<string, unknown>) => string} props.t 文案。
		 */
		function EditOverlay({ initialText, nonText, onSubmit, onClose, t }) {
			const [value, setValue] = React.useState(initialText);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const areaRef = React.useRef(null);
			const alive = React.useRef(true);

			React.useEffect(() => () => { alive.current = false; }, []);
			React.useEffect(() => {
				const area = areaRef.current;
				if (area !== null) {
					area.focus();
					area.setSelectionRange(area.value.length, area.value.length);
				}
			}, []);

			const run = React.useCallback(() => {
				const text = value.trim();
				if (text === "" || busy) return;
				setBusy(true);
				setError(null);
				Promise.resolve()
					.then(() => onSubmit(text))
					.then(() => {
						if (alive.current) setBusy(false);
					})
					.catch((err) => {
						if (!alive.current) return;
						setBusy(false);
						setError(err instanceof Error ? err.message : String(err));
					});
			}, [value, busy, onSubmit]);

			const onKey = React.useCallback((event) => {
				if (event.key === "Escape") onClose();
				else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) run();
			}, [onClose, run]);

			return React.createElement("div", { className: "dshER_overlay", onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
				React.createElement("div", { className: "dshER_panel", role: "dialog", "aria-label": t("editor.title"), onKeyDown: onKey },
					React.createElement("div", { className: "dshER_title" }, t("editor.title")),
					React.createElement("div", { className: "dshER_hint" }, t("editor.hint"),
						nonText ? React.createElement("br", null) : null,
						nonText ? t("editor.nonTextOnly") : null),
					React.createElement("textarea", {
						ref: areaRef,
						className: "dshER_textarea",
						value,
						placeholder: t("editor.placeholder"),
						onChange: (e) => setValue(e.target.value),
					}),
					error !== null ? React.createElement("div", { className: "dshER_error" }, error) : null,
					React.createElement("div", { className: "dshER_row" },
						React.createElement("button", { type: "button", className: "dshER_btn dshER_btnGhost", onClick: onClose, disabled: busy }, t("editor.cancel")),
						React.createElement("button", { type: "button", className: "dshER_btn dshER_btnPrimary", onClick: run, disabled: busy || value.trim() === "" },
							busy ? t("editor.submitting") : t("editor.submit")),
					),
				),
			);
		}
		//#endregion

		//#region fork & resend 动作
		/**
		 * 组合宿主原语完成「编辑重跑」：fork → 向子会话重发 → 导航到子会话。
		 * fork 失败与发送失败分开报告，各自带宿主的错误消息。
		 * @param {object} sessions ctx.sessions（客户端 sessions 服务面）。
		 * @param {object} uiWorkspace ctx.uiWorkspace（导航服务；缺席时只跳过导航）。
		 * @param {string} sessionId 源会话。
		 * @param {number} atSeq 边界事件 seq（含）。
		 * @param {string} text 编辑后的消息文本。
		 * @param {object} hooks 结果回调。
		 * @param {(message: string) => void} hooks.onForkError fork 失败。
		 * @param {(message: string) => void} hooks.onSendError 重发失败。
		 * @returns {Promise<void>} 完成信号（成功路径：已导航到子会话）。
		 */
		async function editAndResend(sessions, workspace, sessionId, atSeq, text, hooks) {
			let childId;
			try {
				childId = await sessions.fork({ sessionId, atSeq, increaseTitle: true });
			} catch (error) {
				hooks.onForkError(describeError(error));
				return;
			}
			// fork 只把子会话写进目录，本身不持有引用；而 `binding(id)` 对没有活跃
			// 引用的世代返回 undefined。所以先 retain 拿到引用，等它的 `ready`
			// （共享的首次 open）落定后再借 binding。
			// `controllerOperation` 是服务契约里为「一次性控制动作」预留的来源标签。
			let reference;
			try {
				reference = sessions.retain(childId, { source: "controllerOperation" });
				const binding = await reference.ready;
				// 子会话此刻必然空闲（刚创建），queue 语义即「立即开跑」。
				// prompt 在 SessionFace 上，不在 binding 上。
				const result = await binding.session.prompt([{ type: "text", text }], "queue");
				if (result !== undefined && result !== null && result.ok === false) {
					hooks.onSendError(describeError(result.error));
					return;
				}
			} catch (error) {
				// fork 已成功：子会话留着，用户可以手动打开或重发。
				hooks.onSendError(describeError(error));
				return;
			} finally {
				// 无论发送成败都把用户带到子会话；导航会以 mainView 来源另持一份，
				// 这里随即释放本次控制动作的引用。
				openChild(workspace, childId);
				reference?.release?.();
			}
		}

		/**
		 * 导航到子会话；导航服务缺席时静默跳过（子会话已在侧栏可见）。
		 * @param {object} uiWorkspace uiWorkspace 服务或 undefined。
		 * @param {string} childId 子会话 id。
		 */
		function openChild(uiWorkspace, childId) {
			try {
				uiWorkspace?.openSession(childId);
			} catch {
				/* 导航失败不影响 fork/重发本身 */
			}
		}

		/**
		 * 宿主错误的可读化：RemoteError 展 message，其余走 String。
		 * @param {unknown} error 任意抛出值。
		 * @returns {string} 可读消息。
		 */
		function describeError(error) {
			if (error !== null && typeof error === "object" && typeof error.message === "string" && error.message !== "") return error.message;
			return String(error);
		}
		//#endregion

		//#region 用户消息渲染器（覆盖内置 user 键）
		/**
		 * 内置用户消息行的增强版：视觉对齐官方气泡（右对齐、圆角、消息动作），
		 * 动作行里多一枚「编辑并重跑」。文本用公开原语 MarkdownText 重绘；
		 * 图片/文件块不在重绘范围内（编辑重发本来也只重发文本），这类消息保留
		 * 编辑入口，浮层里说明限制。
		 *
		 * 标准 props（slots 机制注入）：node / t / sessionId / useAccess /
		 * loadImage / renderFactorySlot。注意 `useSessions` 是选择器 hook
		 * （SnapshotSelectorHook），不是服务本体——服务走 apply 里声明的
		 * `ctx.sessions`。
		 */
		const EditableUserNodeView = React.memo(function EditableUserNodeView({ node, t, sessionId, useAccess, loadImage }) {
			const data = node.data;

			const forkAllowed = typeof useAccess === "function" ? useAccess("session/fork") : false;
			const sendAllowed = typeof useAccess === "function" ? useAccess("session/prompt") : false;
			const canEdit = forkAllowed && sendAllowed && sessionsRef !== undefined && workspaceRef !== undefined && editable(data);

			const [editing, setEditing] = React.useState(false);

			const text = React.useMemo(() => textOf(data.content), [data.content]);
			const nonText = React.useMemo(() => hasNonText(data.content), [data.content]);

			const startEdit = React.useCallback(() => setEditing(true), []);
			const closeEdit = React.useCallback(() => setEditing(false), []);

			const submit = React.useCallback((nextText) => {
				// 成功路径会导航走，本组件随之卸载；失败抛回浮层显示。
				return editAndResend(sessionsRef, workspaceRef, sessionId, data.seq, nextText, {
					onForkError: (message) => { throw new Error(message); },
					onSendError: (message) => { throw new Error(message); },
				});
			}, [sessionId, data.seq]);

			return React.createElement("div", { className: "dshER_host", "data-dsh-edit-resend": "" },
				React.createElement("div", { className: "dshER_stack" },
					React.createElement("div", { className: "dshER_bubble" },
						React.createElement(primitives.MarkdownText, { text, loadImage }),
					),
					React.createElement("div", { className: "dshER_actions" },
						canEdit ? React.createElement(primitives.Tooltip, { label: t("bubble.edit"), side: "bottom" },
							React.createElement("button", {
								type: "button",
								className: "dshER_action",
								"aria-label": t("bubble.edit"),
								onClick: startEdit,
							}, React.createElement(primitives.IconEditOutline16, {})),
						) : null,
					),
				),
				editing ? React.createElement(EditOverlay, {
					initialText: text,
					nonText,
					onSubmit: submit,
					onClose: closeEdit,
					t,
				}) : null,
			);
		});

		/**
		 * apply 时捕获的根级服务引用。两者都在 `inject` 里声明过——动态插件的
		 * ctx 是被守卫的代理，**读未声明的服务会直接抛错并记为包激活失败**。
		 */
		let sessionsRef;
		let workspaceRef;
		//#endregion

		//#region 根作用域装配
		/**
		 * 插件体：把「编辑并重跑」动作注入聊天流。
		 * @param {object} ctx 根作用域 cordis 上下文（动态包装过）。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh: zhDict, en: enDict }), "dsh-edit-resend: dictionaries");

			installStyles();

			// 两个服务都必须在 inject 里声明后才能读；声明同时等于「就绪前不激活」。
			sessionsRef = ctx.sessions;
			workspaceRef = ctx.uiWorkspace;

			// 覆盖内置用户消息渲染器。keyed 插槽同格按 priority 升序取第一个；
			// 动态注册由运行时统一分配（唯一且更低），稳定压过内置的 0。
			ctx.slots.inject("conversation.chat.node", () =>
				ctx.slots.register(
					{
						name: "conversation.chat.node",
						key: "user",
						locale: NS,
					},
					EditableUserNodeView,
				),
			);
		}
		//#endregion

		//#region 文案（兜底字典；locale/*.json 同构）
		const zhDict = {
			"bubble.edit": "编辑并重跑",
			"editor.title": "编辑这条消息",
			"editor.hint": "将从这条消息处 fork 出一个新会话：之前的上下文原样保留（可命中缓存），之后的内容不带入，编辑后的文本作为新消息重新发送。",
			"editor.nonTextOnly": "注意：这条消息带图片/附件，重发只包含文本部分。",
			"editor.placeholder": "输入新的消息内容…",
			"editor.cancel": "取消",
			"editor.submit": "Fork 并重跑",
			"editor.submitting": "正在 fork…",
		};
		const enDict = {
			"bubble.edit": "Edit & rerun",
			"editor.title": "Edit this message",
			"editor.hint": "Forks a new session at this message: everything before it is kept verbatim (cache-friendly), nothing after it is carried over, and the edited text is sent as the next message.",
			"editor.nonTextOnly": "Note: this message carries images/attachments; only its text part is resent.",
			"editor.placeholder": "Type the new message…",
			"editor.cancel": "Cancel",
			"editor.submit": "Fork & rerun",
			"editor.submitting": "Forking…",
		};
		//#endregion

		exports.apply = apply;
		// 根级服务必须在此声明：动态插件 ctx 是守卫代理，未声明的服务读取会抛错。
		exports.inject = ["slots", "locale", "sessions", "uiWorkspace"];
		exports.__internals = {
			textOf, hasNonText, editable, editAndResend, describeError,
			EditableUserNodeView, EditOverlay, zhDict, enDict, NS,
		};
		return module.exports;
	},
});
