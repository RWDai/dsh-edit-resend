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
 * UI 挂点：`conversation.chat.node` 的 `user` 键。keyed 插槽同格按 priority 升序
 * 取第一个渲染；动态包注册的 priority 由运行时统一分配（唯一且低于内置），无需
 * 自己填。
 *
 * ★ 覆盖内置渲染器时**只做外壳，不重画内容**：
 *   气泡内容（Markdown、图片、附件、引用标签、额外块）一律交回内置的
 *   `conversation.chat.user.content` 工厂（`renderFactorySlot`，每个插槽条目都会
 *   拿到这个 seat）。自行用 primitives 重画会在 API 变动时静默炸掉整行 —— 插槽
 *   错误边界会吃掉异常并把该行渲染成空 div，而聊天流对空节点有 `:empty{height:0}`
 *   折叠，表现就是「用户消息凭空消失」。教训：这一层只允许增加动作按钮。
 *
 * 服务与 props：
 *   - 根级服务 `sessions` / `uiWorkspace`（连同 `slots` / `locale`）都写在
 *     `exports.inject` 里。动态插件的 ctx 是被守卫的代理：**读未声明的服务会
 *     直接抛错，并被记为包激活失败**。
 *   - 组件标准 props：`sessionId`（会话作用域自动携带）、`useAccess`（权限
 *     查询）、`loadImage`、`renderFactorySlot`。注意 `useSessions` 是选择器
 *     hook，不是服务本体。
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
		/** 内置用户消息内容工厂：气泡本体的唯一权威渲染器。 */
		const CONTENT_FACTORY = "conversation.chat.user.content";

		/**
		 * `useAccess` 缺席时的兜底：交给宿主在真正执行时拒绝。
		 * @param {string} _action 远端端点（忽略）。
		 * @returns {boolean} 恒为真。
		 */
		function allowAll(_action) {
			return true;
		}

		/**
		 * 图标容错：上游改名/删名时降级成文字，绝不把 `undefined` 交给
		 * `React.createElement`（那会抛错并让整行被错误边界吃成空 div）。
		 * @param {unknown} Component primitives 上的图标组件。
		 * @param {string} fallback 缺席时的文字。
		 * @returns {object|string} 可渲染值。
		 */
		function glyph(Component, fallback) {
			return Component === undefined || Component === null ? fallback : React.createElement(Component, {});
		}

		/**
		 * 提示容错：Tooltip 缺席时直接渲染子元素。
		 * @param {string} label 提示文案。
		 * @param {object} child 被包裹的按钮。
		 * @returns {object} 可渲染值。
		 */
		function tooltip(label, child) {
			const Face = primitives.Tooltip;
			return Face === undefined || Face === null ? child : React.createElement(Face, { label, side: "bottom" }, child);
		}

		//#region 样式
		const CSS = [
			// 外壳与内置 userRow 同构：右对齐、纵向排列。
			".dshER_host{flex-direction:column;align-items:flex-end;gap:6px;display:flex}",
			// 动作行与内置 MessageIconActions 同构。
			".dshER_actions{height:calc(28px + var(--dsh-content-font-delta,0px));align-items:center;gap:8px;display:flex}",
			".dshER_time{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px}",
			".dshER_action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}",
			".dshER_action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}",
			".dshER_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			// 内容工厂缺席时的纯文本兜底（正常路径不会走到）。
			".dshER_fallback{background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl);max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;padding:10px 16px}",
			// 与内置一致：只有最后一条用户消息常显动作，历史行悬停才显。
			"@media (hover:hover){:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])) .dshER_actions{opacity:0;transition:opacity 80ms}:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):hover .dshER_actions,:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):focus-within .dshER_actions{opacity:1}}",
			// 编辑浮层。
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
		 * 把一条用户消息的 content 块拆成内置内容工厂要的形状。
		 * 与内置 `contentParts` 同构：文本拼接、图片/文件进 attachments、其余进
		 * extraBlocks。
		 * @param {{content?: readonly unknown[], referenceLabels?: unknown}} data 节点数据。
		 * @returns {{text: string, attachments: unknown[], extraBlocks: unknown[], referenceLabels?: unknown}} 工厂入参。
		 */
		function splitContent(data) {
			const texts = [];
			const attachments = [];
			const extraBlocks = [];
			for (const block of data.content ?? []) {
				if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") texts.push(block.text);
				else if (block !== null && typeof block === "object" && block.type === "image" && block.attachment !== undefined) attachments.push({ type: "image", image: { attachment: block.attachment } });
				else if (block !== null && typeof block === "object" && block.type === "file" && block.attachment !== undefined) attachments.push({ type: "file", file: block.attachment });
				else extraBlocks.push(block);
			}
			const prepared = { text: texts.join(""), attachments, extraBlocks };
			// 只有存在时才带上：内置按 `referenceLabels.length` 判空。
			if (data.referenceLabels !== undefined) prepared.referenceLabels = data.referenceLabels;
			return prepared;
		}

		/**
		 * 内置内容工厂的 facts seat：只搬运节点自带的会话标签/技能名。
		 * @param {{referenceLabels?: unknown, skillNames?: unknown}} data 节点数据。
		 * @returns {object} 工厂 facts。
		 */
		function contentFacts(data) {
			const facts = {};
			if (data.referenceLabels !== undefined) facts.sessionLabels = data.referenceLabels;
			if (data.skillNames !== undefined) facts.skillNames = data.skillNames;
			return facts;
		}

		/**
		 * 计算 fork 边界：目标用户消息所在 turn 的**上一个已完成 turn 的 end.seq**。
		 *
		 * 为什么不能用消息自己的 seq：`sessions.fork` 的 `atSeq` 是**闭区间**，会把
		 * 这条 user/message 原样复制进子会话；随后我们再 prompt 编辑后的文本，子会话
		 * 里就会出现两条连续的用户消息（一条继承的原文、一条新文本）——用户看到的
		 * 就是「消息重复」。也不能用 `seq - 1`：那会落在 turn 内部，host 会补合成
		 * step/end + turn/end，留下一个没有任何消息的空 turn。
		 *
		 * 切在上一 turn 的 `turn/end` 上则是最干净的边界：前缀是平衡的（不会补收尾），
		 * 被编辑的那条消息及其整轮都不进入子会话，编辑后的文本成为新 turn 的第一条
		 * 消息。模型可见历史到上一个 turn 结束为止逐字节不变，prompt cache 照样命中。
		 *
		 * 目标消息属于会话第一轮时没有「上一个 turn」，退化为 `seq - 1`（会留下一个
		 * 被合成收尾的空 turn，但同样不影响可见历史与缓存）。
		 * @param {object} snapshot ChatSnapshot（`useChat` 选择器的入参）。
		 * @param {number} seq 目标用户消息的事件 seq。
		 * @returns {number} 传给 `sessions.fork` 的闭区间边界。
		 */
		function previousTurnEnd(snapshot, seq) {
			const fallback = Math.max(0, seq - 1);
			const turns = snapshot?.timeline?.turns;
			if (turns === undefined || turns === null || typeof turns.values !== "function") return fallback;
			let boundary;
			for (const turn of turns.values()) {
				const end = turn?.end?.seq;
				// 只认严格早于目标消息的 turn/end：目标消息所在 turn 自己的 end 在其之后。
				if (typeof end === "number" && end < seq && (boundary === undefined || end > boundary)) boundary = end;
			}
			return boundary ?? fallback;
		}

		/**
		 * `useChat` 缺席时的兜底选择器座位（不是 hook，只返回 undefined）。
		 * @returns {undefined} 恒为 undefined。
		 */
		function noSnapshot() {
			return undefined;
		}

		/**
		 * 消息时间戳的可读化：同日只给 HH:MM，跨日补上日期。
		 * @param {unknown} time Unix epoch ms。
		 * @returns {string} 空串（时间缺失）或可读时间。
		 */
		function formatClock(time) {
			if (typeof time !== "number" || !Number.isFinite(time)) return "";
			const date = new Date(time);
			const now = new Date();
			const pad = (value) => (value < 10 ? `0${value}` : String(value));
			const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
			if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return clock;
			const day = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric" }).format(date);
			return `${day} ${clock}`;
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

		//#region 编辑浮层
		/**
		 * 编辑浮层。打开时填入原文本；确认走 fork+resend，失败把错误留在浮层里，
		 * 成功由父级随会话切换卸载本组件。
		 * @param {object} props 组件属性。
		 * @param {string} props.initialText 原消息文本。
		 * @param {boolean} props.nonText 是否携带非文本块。
		 * @param {number} props.seq 目标消息的事件 seq。
		 * @param {Function} props.useChat Chat 快照选择器 hook（标准 prop）。
		 * @param {(text: string, atSeq: number) => Promise<void>} props.onSubmit 确认回调（抛错=失败）。
		 * @param {() => void} props.onClose 关闭回调。
		 * @param {(key: string, params?: Record<string, unknown>) => string} props.t 文案。
		 */
		function EditOverlay({ initialText, nonText, seq, useChat, onSubmit, onClose, t }) {
			const [value, setValue] = React.useState(initialText);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const areaRef = React.useRef(null);
			const alive = React.useRef(true);

			// 浮层是唯一需要 turn 边界的地方：放在这里而不是每一行里，是为了避免每条
			// 用户消息都订阅一次 Chat 快照（长会话里那是 O(行数 × turn 数)）。
			const readChat = typeof useChat === "function" ? useChat : noSnapshot;
			const selected = readChat((snapshot) => previousTurnEnd(snapshot, seq));
			const atSeq = typeof selected === "number" && Number.isFinite(selected) ? selected : Math.max(0, seq - 1);

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
					.then(() => onSubmit(text, atSeq))
					.then(() => {
						if (alive.current) setBusy(false);
					})
					.catch((err) => {
						if (!alive.current) return;
						setBusy(false);
						setError(err instanceof Error ? err.message : String(err));
					});
			}, [value, busy, onSubmit, atSeq]);

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
		 * 失败不抛异常，返回带阶段与消息的结果，调用方决定怎么展示。
		 * @param {object} sessions ctx.sessions（客户端 sessions 服务面）。
		 * @param {object} uiWorkspace ctx.uiWorkspace（导航服务；缺席时只跳过导航）。
		 * @param {string} sessionId 源会话。
		 * @param {number} atSeq 边界事件 seq（含）；调用方应传上一个已完成 turn 的 end.seq。
		 * @param {string} text 编辑后的消息文本。
		 * @returns {Promise<{ok: boolean, childId?: string, stage?: string, error?: string}>} 结果。
		 */
		async function editAndResend(sessions, uiWorkspace, sessionId, atSeq, text) {
			let childId;
			try {
				childId = await sessions.fork({ sessionId, atSeq, increaseTitle: true });
			} catch (error) {
				return { ok: false, stage: "fork", error: describeError(error) };
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
					return { ok: false, childId, stage: "send", error: describeError(result.error) };
				}
				return { ok: true, childId };
			} catch (error) {
				// fork 已成功：子会话留着，用户可以手动打开或重发。
				return { ok: false, childId, stage: "send", error: describeError(error) };
			} finally {
				// 无论发送成败都把用户带到子会话；导航会以 mainView 来源另持一份，
				// 这里随即释放本次控制动作的引用。
				openChild(uiWorkspace, childId);
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
		//#endregion

		//#region 用户消息渲染器（覆盖内置 user 键）
		/**
		 * 内置用户消息行的外壳版：气泡内容仍由内置 `conversation.chat.user.content`
		 * 工厂渲染（Markdown / 图片 / 附件 / 引用标签全部原样），本插件只在动作行里
		 * 追加「编辑并重跑」，并把内置的复制/时间一并对齐。
		 *
		 * 标准 props（slots 机制注入）：node / t / sessionId / useAccess /
		 * loadImage / renderFactorySlot。
		 */
		const EditableUserNodeView = React.memo(function EditableUserNodeView({ node, renderFactorySlot, loadImage, t, sessionId, useAccess, useChat }) {
			const data = node.data;
			const [editing, setEditing] = React.useState(false);
			const [copied, setCopied] = React.useState(false);
			const copyTimer = React.useRef(null);

			React.useEffect(() => () => {
				if (copyTimer.current !== null) clearTimeout(copyTimer.current);
			}, []);

			const content = React.useMemo(() => splitContent(data), [data]);
			const facts = React.useMemo(() => contentFacts(data), [data]);
			const text = content.text;
			const nonText = content.attachments.length > 0 || content.extraBlocks.length > 0;

			const access = typeof useAccess === "function" ? useAccess : allowAll;
			const canEdit = editable(data)
				&& sessionsRef !== undefined
				&& workspaceRef !== undefined
				&& access("session/fork")
				&& access("session/prompt");

			const startEdit = React.useCallback(() => setEditing(true), []);
			const closeEdit = React.useCallback(() => setEditing(false), []);

			const copy = React.useCallback(() => {
				if (text === "" || copied) return;
				Promise.resolve(primitives.writeClipboard(text)).then((ok) => {
					if (ok !== true) return;
					setCopied(true);
					if (copyTimer.current !== null) clearTimeout(copyTimer.current);
					copyTimer.current = setTimeout(() => {
						copyTimer.current = null;
						setCopied(false);
					}, 1000);
				}).catch(() => {});
			}, [text, copied]);

			const submit = React.useCallback((nextText, atSeq) => {
				// 成功路径会导航走，本组件随之卸载；失败抛回浮层显示。
				// atSeq 由浮层按 Chat 快照算出（上一个 turn 的 end），不是 data.seq：
				// 闭区间 fork 若含本条消息，子会话里就会出现「原文 + 编辑文本」两条。
				return editAndResend(sessionsRef, workspaceRef, sessionId, atSeq, nextText).then((result) => {
					if (result.ok !== true) throw new Error(result.error ?? t("editor.failed"));
				});
			}, [sessionId, t]);

			// 内容一律回到内置工厂：本插件不重画气泡，避免任何 primitives 变动把整行
			// 打空（插槽错误边界会把抛错的行渲染成空 div，聊天流再把它折叠成 0 高）。
			const body = typeof renderFactorySlot === "function"
				? renderFactorySlot(CONTENT_FACTORY, { content, loadImage, facts, interactive: true })
				: React.createElement("div", { className: "dshER_fallback" }, text);

			const copyLabel = copied ? t("bubble.copied") : t("bubble.copy");
			const clock = formatClock(data.time);

			return React.createElement("div", { className: "dshER_host", "data-dsh-edit-resend": "" },
				body,
				React.createElement("div", { className: "dshER_actions", "data-clock": "start" },
					clock === "" ? null : React.createElement("span", { className: "dshER_time" }, clock),
					text === "" ? null : tooltip(copyLabel,
						React.createElement("button", { type: "button", className: "dshER_action", "aria-label": copyLabel, onClick: copy },
							glyph(copied ? primitives.IconCheckOutlineRegular : primitives.IconCopyOutlineRegular, "⧉")),
					),
					canEdit ? tooltip(t("bubble.edit"),
						React.createElement("button", { type: "button", className: "dshER_action", "aria-label": t("bubble.edit"), onClick: startEdit },
							glyph(primitives.IconEditOutlineRegular, "✎")),
					) : null,
				),
				editing ? React.createElement(EditOverlay, {
					initialText: text,
					nonText,
					seq: data.seq,
					useChat,
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
			"bubble.copy": "复制",
			"bubble.copied": "已复制",
			"editor.title": "编辑这条消息",
			"editor.hint": "将从这条消息处 fork 出一个新会话：之前的上下文原样保留（可命中缓存），之后的内容不带入，编辑后的文本作为新消息重新发送。",
			"editor.nonTextOnly": "注意：这条消息带图片/附件，重发只包含文本部分。",
			"editor.placeholder": "输入新的消息内容…",
			"editor.cancel": "取消",
			"editor.submit": "Fork 并重跑",
			"editor.submitting": "正在 fork…",
			"editor.failed": "操作失败，请重试",
		};
		const enDict = {
			"bubble.edit": "Edit & rerun",
			"bubble.copy": "Copy",
			"bubble.copied": "Copied",
			"editor.title": "Edit this message",
			"editor.hint": "Forks a new session at this message: everything before it is kept verbatim (cache-friendly), nothing after it is carried over, and the edited text is sent as the next message.",
			"editor.nonTextOnly": "Note: this message carries images/attachments; only its text part is resent.",
			"editor.placeholder": "Type the new message…",
			"editor.cancel": "Cancel",
			"editor.submit": "Fork & rerun",
			"editor.submitting": "Forking…",
			"editor.failed": "Failed, please retry",
		};
		//#endregion

		exports.apply = apply;
		// 根级服务必须在此声明：动态插件 ctx 是守卫代理，未声明的服务读取会抛错。
		exports.inject = ["slots", "locale", "sessions", "uiWorkspace"];
		exports.__internals = {
			splitContent, contentFacts, formatClock, editable, editAndResend, describeError, previousTurnEnd,
			EditableUserNodeView, EditOverlay, zhDict, enDict, NS, CONTENT_FACTORY,
		};
		return module.exports;
	},
});
