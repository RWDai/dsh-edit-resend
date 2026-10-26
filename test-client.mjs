/**
 * dsh-edit-resend 客户端半的离线自检。
 *
 * 用最小 React 垫片执行 `EditableUserNodeView`，重点盯住三件曾经把整行打空的
 * 事：元素类型为 undefined、组件渲染期抛错、以及 hook 顺序错乱。
 *
 * 运行：node test-client.mjs
 */
import { readFileSync } from "node:fs";

//#region 最小 React 垫片
function createElement(type, props, ...children) {
	const next = { ...(props ?? {}) };
	if (children.length === 1) next.children = children[0];
	else if (children.length > 1) next.children = children;
	return { __element: true, type, props: next };
}
const shim = {
	createElement,
	memo: (component) => component,
	Fragment: Symbol.for("react.fragment"),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useMemo: (factory) => factory(),
	useCallback: (callback) => callback,
	useRef: (initial) => ({ current: initial }),
	useEffect: () => {},
	useLayoutEffect: () => {},
};
//#endregion

//#region 最小 primitives 垫片（名字与 dsh 0.2.1 的导出表一致）
const GLYPH = "GLYPH";
const primitives = {
	Tooltip: "Tooltip",
	IconEditOutlineRegular: GLYPH,
	IconCopyOutlineRegular: GLYPH,
	IconCheckOutlineRegular: GLYPH,
	writeClipboard: async () => true,
};
function missingPrimitives() {
	// 极端降级：primitives 只剩空壳，模拟上游改名。
	return { writeClipboard: async () => true };
}
//#endregion

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

/** 从插件源码里取出工厂（文件只是调用 window.__ModuleLoader__）。 */
function loadModule(primitiveFace) {
	let factory;
	const window = { __ModuleLoader__: { load: (descriptor) => { factory = descriptor.factory; } } };
	const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
	new Function("window", source)(window);
	const require = (id) => {
		if (id === "react") return shim;
		if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitiveFace;
		throw new Error(`unexpected require: ${id}`);
	};
	return factory(require);
}

/** 遍历渲染树：任何 undefined 元素类型都算硬伤。 */
function walk(node, visit, path = "root") {
	if (node === null || node === undefined || typeof node !== "object") {
		visit(node, path);
		return;
	}
	if (Array.isArray(node)) {
		node.forEach((child, index) => walk(child, visit, `${path}[${index}]`));
		return;
	}
	visit(node, path);
	if (node.props?.children !== undefined) walk(node.props.children, visit, `${path}.children`);
}

function assertRenderable(label, tree) {
	const problems = [];
	walk(tree, (node, path) => {
		if (node !== null && typeof node === "object" && node.__element === true && node.type === undefined) problems.push(path);
	});
	check(`${label}：没有 undefined 元素类型`, problems.length === 0, problems.join(", "));
}

function collect(tree, predicate) {
	const hits = [];
	walk(tree, (node, path) => {
		if (node !== null && typeof node === "object" && node.__element === true && predicate(node)) hits.push(path);
	});
	return hits;
}

function texts(tree) {
	const out = [];
	walk(tree, (node) => {
		if (typeof node === "string" || typeof node === "number") out.push(String(node));
	});
	return out;
}

const userData = {
	kind: "user",
	seq: 41,
	time: Date.now(),
	content: [{ type: "text", text: "把缓存命中这件事讲清楚" }],
	source: { kind: "user" },
};
const steeringData = { ...userData, kind: "user", source: { kind: "steering" } };

/** 渲染一次组件，返回渲染树。 */
function render(mod, overrides = {}, faces = {}) {
	const calls = [];
	const props = {
		node: { data: userData, key: "user", kind: "user" },
		t: (key) => `[${key}]`,
		sessionId: "session-1",
		useAccess: () => true,
		loadImage: () => undefined,
		renderFactorySlot: (name, input) => {
			calls.push({ name, input });
			return createElement("FACTORY", { name });
		},
		...overrides,
	};
	const tree = mod.__internals.EditableUserNodeView(props);
	return { tree, calls };
}

console.log("\n# 组件渲染（primitives 完整）");
{
	const mod = loadModule(primitives);
	mod.apply({
		effect: (run) => run(),
		locale: { register: () => () => {} },
		slots: { inject: () => {}, register: () => () => {} },
		sessions: {},
		uiWorkspace: {},
	});

	const { tree, calls } = render(mod);
	assertRenderable("默认渲染", tree);
	check("内容交给内置工厂", calls.length === 1 && calls[0].name === mod.__internals.CONTENT_FACTORY, JSON.stringify(calls.map((c) => c.name)));
	check("工厂入参是拆分后的文本", calls[0].input.content.text === "把缓存命中这件事讲清楚", JSON.stringify(calls[0].input.content));
	check("交互位打开", calls[0].input.interactive === true);
	check("动作行渲染编辑按钮", collect(tree, (n) => n.props?.["aria-label"] === "[bubble.edit]").length === 1);
	check("动作行渲染复制按钮", collect(tree, (n) => n.props?.["aria-label"] === "[bubble.copy]").length === 1);
	check("时间已渲染", texts(tree).some((value) => /^\d{2}:\d{2}$/.test(value)), texts(tree).join("|"));

	const denied = render(mod, { useAccess: () => false });
	check("无权限时不出编辑按钮", collect(denied.tree, (n) => n.props?.["aria-label"] === "[bubble.edit]").length === 0);
	assertRenderable("无权限渲染", denied.tree);

	const steering = render(mod, { node: { data: steeringData, key: "user", kind: "user" } });
	check("steering 不出编辑按钮", collect(steering.tree, (n) => n.props?.["aria-label"] === "[bubble.edit]").length === 0);
	assertRenderable("steering 渲染", steering.tree);

	const noFactory = render(mod, { renderFactorySlot: undefined });
	assertRenderable("工厂缺席渲染", noFactory.tree);
	check("工厂缺席时走纯文本兜底", texts(noFactory.tree).includes("把缓存命中这件事讲清楚"));

	const noAccess = render(mod, { useAccess: undefined });
	assertRenderable("useAccess 缺席渲染", noAccess.tree);
	check("useAccess 缺席时仍出编辑按钮", collect(noAccess.tree, (n) => n.props?.["aria-label"] === "[bubble.edit]").length === 1);

	const withImage = render(mod, {
		node: {
			data: { ...userData, content: [{ type: "text", text: "看图" }, { type: "image", attachment: { id: "a1" } }] },
			key: "user",
			kind: "user",
		},
	});
	check("图片块进 attachments", withImage.calls[0].input.content.attachments.length === 1, JSON.stringify(withImage.calls[0].input.content));
	assertRenderable("图片消息渲染", withImage.tree);
}

console.log("\n# 组件渲染（primitives 仅剩 writeClipboard，模拟上游改名）");
{
	const mod = loadModule(missingPrimitives());
	const { tree } = render(mod);
	assertRenderable("降级渲染", tree);
}

console.log("\n# editAndResend");
{
	const mod = loadModule(primitives);
	const { editAndResend } = mod.__internals;

	const events = [];
	const makeSessions = (overrides = {}) => ({
		fork: async (request) => {
			events.push(["fork", request]);
			return overrides.forkError === undefined ? "child-1" : Promise.reject(new Error(overrides.forkError));
		},
		retain: (id, options) => {
			events.push(["retain", id, options.source]);
			return {
				ready: overrides.readyError === undefined
					? Promise.resolve({ session: { prompt: async (content, mode) => { events.push(["prompt", content, mode]); return overrides.promptResult; } } })
					: Promise.reject(new Error(overrides.readyError)),
				release: () => events.push(["release"]),
			};
		},
	});
	const workspace = { openSession: (id) => events.push(["open", id]) };

	events.length = 0;
	const happy = await editAndResend(makeSessions(), workspace, "session-1", 41, "改过的文本");
	check("成功路径 ok", happy.ok === true && happy.childId === "child-1", JSON.stringify(happy));
	check("成功路径顺序 fork→retain→prompt→open→release", JSON.stringify(events.map((e) => e[0])) === JSON.stringify(["fork", "retain", "prompt", "open", "release"]), JSON.stringify(events.map((e) => e[0])));
	check("prompt 用 queue 且只发文本", JSON.stringify(events[2][1]) === JSON.stringify([{ type: "text", text: "改过的文本" }]) && events[2][2] === "queue");
	check("fork 边界是消息自身 seq", events[0][1].atSeq === 41 && events[0][1].sessionId === "session-1");

	events.length = 0;
	const forkFailed = await editAndResend(makeSessions({ forkError: "forbidden" }), workspace, "session-1", 41, "x");
	check("fork 失败如实上报", forkFailed.ok === false && forkFailed.stage === "fork" && forkFailed.error === "forbidden", JSON.stringify(forkFailed));
	check("fork 失败不导航、不释放", events.map((e) => e[0]).join(",") === "fork", events.map((e) => e[0]).join(","));

	events.length = 0;
	const sendFailed = await editAndResend(makeSessions({ readyError: "no binding" }), workspace, "session-1", 41, "x");
	check("发送失败如实上报", sendFailed.ok === false && sendFailed.stage === "send" && sendFailed.error === "no binding", JSON.stringify(sendFailed));
	check("发送失败仍导航并释放", events.map((e) => e[0]).join(",") === "fork,retain,open,release", events.map((e) => e[0]).join(","));

	events.length = 0;
	const refused = await editAndResend(makeSessions({ promptResult: { ok: false, error: new Error("model busy") } }), workspace, "session-1", 41, "x");
	check("宿主拒绝发送只报一次", refused.ok === false && refused.stage === "send" && refused.error === "model busy", JSON.stringify(refused));

	const navigationThrows = await editAndResend(makeSessions(), { openSession: () => { throw new Error("nav boom"); } }, "session-1", 41, "x");
	check("导航异常不影响成功结果", navigationThrows.ok === true, JSON.stringify(navigationThrows));
}

console.log("\n# 纯函数");
{
	const mod = loadModule(primitives);
	const { splitContent, contentFacts, editable, describeError, formatClock, zhDict, enDict } = mod.__internals;
	const prepared = splitContent({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "file", attachment: { name: "x" } }, { type: "tool" }] });
	check("文本拼接", prepared.text === "ab", prepared.text);
	check("文件进 attachments", prepared.attachments.length === 1);
	check("未知块进 extraBlocks", prepared.extraBlocks.length === 1);
	check("无 referenceLabels 时不带该键", !("referenceLabels" in prepared));
	check("facts 默认空", JSON.stringify(contentFacts({})) === "{}");
	check("editable 判据", editable(userData) === true && editable({ ...userData, source: { kind: "steering" } }) === false && editable({ ...userData, seq: undefined }) === false);
	check("describeError", describeError(new Error("x")) === "x" && describeError("y") === "y" && describeError({ message: "" }) === "[object Object]");
	check("formatClock 时间缺失给空串", formatClock(undefined) === "" && formatClock("x") === "");
	const keys = Object.keys(zhDict);
	check("中英文字典键一致", JSON.stringify(keys) === JSON.stringify(Object.keys(enDict)), `${keys.length} vs ${Object.keys(enDict).length}`);
}

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
