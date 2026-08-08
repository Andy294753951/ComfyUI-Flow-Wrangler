import { app } from "../../scripts/app.js";

const EXTENSION_NAME = "Comfy.FlowWrangler";
const EXTENSION_VERSION = "0.2.2";
const SETTING_GESTURE = `${EXTENSION_NAME}.LazyConnectGesture`;
const SETTING_REPLACE = `${EXTENSION_NAME}.ReplaceConnectedInputs`;
const BYPASS_MODE = 4;
const ALWAYS_MODE = 0;

let gestureEnabled = true;
let replaceConnectedInputs = false;
let lastPointer = { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 };
let lazyGesture = null;
let pendingClickSource = null;
let suppressContextMenuUntil = 0;
let gestureOverlay = null;

function notify(detail, severity = "info") {
    const toast = app.extensionManager?.toast;
    if (toast?.add) {
        toast.add({ severity, summary: "Flow Wrangler", detail, life: 2600 });
        return;
    }
    console.log(`[Flow Wrangler] ${detail}`);
}

function graphChanged(fn) {
    const graph = app.graph;
    graph?.beforeChange?.();
    try {
        return fn();
    } finally {
        graph?.afterChange?.();
        graph?.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
    }
}

function normalizeType(type) {
    if (Array.isArray(type)) return type.map(normalizeType).join(",");
    return String(type ?? "*").trim().toUpperCase();
}

function normalizeName(value) {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function typesCompatible(outputType, inputType) {
    const out = normalizeType(outputType);
    const input = normalizeType(inputType);
    if (out === "*" || input === "*" || out === input) return true;
    if (typeof LiteGraph.isValidConnection === "function") {
        try {
            return LiteGraph.isValidConnection(outputType, inputType);
        } catch (_) {
            // Fall back to the union-type check below.
        }
    }
    const outParts = out.split(",").map((part) => part.trim());
    const inputParts = input.split(",").map((part) => part.trim());
    return outParts.some((part) => inputParts.includes(part));
}

function selectedNodes() {
    const canvas = app.canvas;
    const collections = [
        canvas?.selected_nodes,
        canvas?.selectedNodes,
        canvas?.selected_items,
        canvas?.selectedItems,
    ];
    const result = [];
    const seen = new Set();
    for (const collection of collections) {
        if (!collection) continue;
        let values;
        if (collection instanceof Map || collection instanceof Set) values = [...collection.values()];
        else if (Array.isArray(collection)) values = collection;
        else values = Object.values(collection);
        for (const item of values) {
            const node = item?.node ?? item;
            if (!node || seen.has(node) || node.isGroup || (!node.inputs && !node.outputs)) continue;
            seen.add(node);
            result.push(node);
        }
        if (result.length) break;
    }
    return result;
}

function focusedNodes(minimum = 1) {
    const selected = selectedNodes();
    if (selected.length >= minimum) return selected;
    const current = app.canvas?.current_node;
    return current && !current.isGroup ? [current] : selected;
}

function pairScore(source, outputIndex, target, inputIndex, allowReplace = false) {
    const output = source.outputs?.[outputIndex];
    const input = target.inputs?.[inputIndex];
    if (!output || !input || !typesCompatible(output.type, input.type)) return -Infinity;
    if (input.link != null && !allowReplace) return -Infinity;

    const outputType = normalizeType(output.type);
    const inputType = normalizeType(input.type);
    const outputName = normalizeName(output.name ?? output.label);
    const inputName = normalizeName(input.name ?? input.label);
    let score = outputType === inputType ? 120 : 65;
    if (outputType === "*" || inputType === "*") score -= 35;
    if (input.link == null) score += 30;
    else score -= 20;
    if (outputName && inputName) {
        if (outputName === inputName) score += 42;
        else if (outputName.includes(inputName) || inputName.includes(outputName)) score += 18;
    }
    score -= Math.abs(outputIndex - inputIndex) * 0.35;
    return score;
}

function bestPair(source, target, allowReplace = replaceConnectedInputs) {
    let best = null;
    for (let outputIndex = 0; outputIndex < (source.outputs?.length ?? 0); outputIndex++) {
        for (let inputIndex = 0; inputIndex < (target.inputs?.length ?? 0); inputIndex++) {
            const score = pairScore(source, outputIndex, target, inputIndex, allowReplace);
            if (!best || score > best.score) best = { source, target, outputIndex, inputIndex, score };
        }
    }
    return best?.score > -Infinity ? best : null;
}

function connectPair(pair) {
    if (!pair) return false;
    if (pair.target.inputs[pair.inputIndex]?.link != null) {
        pair.target.disconnectInput?.(pair.inputIndex);
    }
    const result = pair.source.connect(pair.outputIndex, pair.target, pair.inputIndex);
    return result !== false && result != null;
}

function smartConnectBetween(first, second, explicitDirection = false) {
    if (!first || !second || first === second) return false;
    let pair = bestPair(first, second);
    if (!explicitDirection) {
        const reverse = bestPair(second, first);
        if (!pair || (reverse && reverse.score > pair.score + 8)) pair = reverse;
    }
    if (!pair) return false;
    return connectPair(pair);
}

function slotPosition(node, isInput, slotIndex) {
    const fallback = [
        node.pos?.[0] + (isInput ? 0 : (node.size?.[0] ?? 180)),
        node.pos?.[1] + 34 + slotIndex * 20,
    ];
    if (typeof node.getConnectionPos !== "function") return fallback;
    try {
        const result = node.getConnectionPos(isInput, slotIndex, [0, 0]);
        return Array.isArray(result) || ArrayBuffer.isView(result) ? [result[0], result[1]] : fallback;
    } catch (_) {
        return fallback;
    }
}

function wouldCreateCycle(source, target) {
    if (source === target) return true;
    const wantedId = String(source.id);
    const queue = [target];
    const visited = new Set();
    while (queue.length) {
        const node = queue.shift();
        const id = String(node.id);
        if (id === wantedId) return true;
        if (visited.has(id)) continue;
        visited.add(id);
        for (const output of node.outputs ?? []) {
            for (const linkId of output.links ?? []) {
                const link = app.graph?.links?.[linkId];
                const next = link ? app.graph.getNodeById(link.target_id) : null;
                if (next && !visited.has(String(next.id))) queue.push(next);
            }
        }
    }
    return false;
}

function globalCandidateScore(source, outputIndex, target, inputIndex, reusedForTarget = false) {
    const base = pairScore(source, outputIndex, target, inputIndex, replaceConnectedInputs);
    if (base === -Infinity || wouldCreateCycle(source, target)) return -Infinity;

    const output = source.outputs[outputIndex];
    const input = target.inputs[inputIndex];
    const outputPos = slotPosition(source, false, outputIndex);
    const inputPos = slotPosition(target, true, inputIndex);
    const dx = inputPos[0] - outputPos[0];
    const dy = Math.abs(inputPos[1] - outputPos[1]);
    const outputName = normalizeName(output.name ?? output.label);
    const inputName = normalizeName(input.name ?? input.label);
    const exactType = normalizeType(output.type) === normalizeType(input.type);

    let score = base + (exactType ? 720 : 260);
    score += dx >= -12 ? 360 : -900;
    score -= Math.min(Math.abs(dx), 2400) * 0.12;
    score -= Math.min(dy, 1800) * 0.08;
    if (outputName && inputName) {
        if (outputName === inputName) score += 360;
        else if (outputName.includes(inputName) || inputName.includes(outputName)) score += 150;
    }
    if (reusedForTarget) score -= 520;
    return score;
}

function bestGlobalCandidate(nodes, target, inputIndex, usedByTarget) {
    let best = null;
    for (const source of nodes) {
        if (source === target) continue;
        for (let outputIndex = 0; outputIndex < (source.outputs?.length ?? 0); outputIndex++) {
            const key = `${source.id}:${outputIndex}`;
            const score = globalCandidateScore(
                source,
                outputIndex,
                target,
                inputIndex,
                usedByTarget.has(key),
            );
            if (!best || score > best.score) {
                best = { source, target, outputIndex, inputIndex, score, key };
            }
        }
    }
    return best?.score > -Infinity ? best : null;
}

function smartConnectSelection() {
    const nodes = selectedNodes().sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1]);
    if (nodes.length < 2) {
        notify("请至少选择两个节点", "warn");
        return false;
    }
    let connected = 0;
    let unresolved = 0;
    graphChanged(() => {
        for (const target of nodes) {
            const usedByTarget = new Set();
            for (let inputIndex = 0; inputIndex < (target.inputs?.length ?? 0); inputIndex++) {
                const input = target.inputs[inputIndex];
                if (input.link != null && !replaceConnectedInputs) continue;
                const candidate = bestGlobalCandidate(nodes, target, inputIndex, usedByTarget);
                if (!candidate) {
                    unresolved++;
                    continue;
                }
                if (connectPair(candidate)) {
                    usedByTarget.add(candidate.key);
                    connected++;
                } else {
                    unresolved++;
                }
            }
        }
    });
    if (connected) {
        const suffix = unresolved ? `；${unresolved} 个输入在所选节点中没有兼容来源` : "";
        notify(`已智能连接 ${connected} 条连线${suffix}`, unresolved ? "info" : "success");
    }
    else notify("未找到可兼容的空闲插槽", "warn");
    return connected > 0;
}

function linkedInputSnapshot(node, inputIndex) {
    const linkId = node.inputs?.[inputIndex]?.link;
    const link = linkId == null ? null : app.graph?.links?.[linkId];
    if (!link) return null;
    const origin = app.graph.getNodeById(link.origin_id);
    const output = origin?.outputs?.[link.origin_slot];
    return origin && output ? { origin, originSlot: link.origin_slot, type: output.type } : null;
}

function swapLinkedInputs() {
    const node = focusedNodes(1)[0];
    if (!node) {
        notify("请选择一个节点", "warn");
        return false;
    }
    const linked = (node.inputs ?? [])
        .map((input, index) => ({ input, index, snapshot: linkedInputSnapshot(node, index) }))
        .filter((entry) => entry.snapshot);

    let pair = null;
    for (let a = 0; a < linked.length && !pair; a++) {
        for (let b = a + 1; b < linked.length; b++) {
            if (
                typesCompatible(linked[a].snapshot.type, linked[b].input.type) &&
                typesCompatible(linked[b].snapshot.type, linked[a].input.type)
            ) {
                pair = [linked[a], linked[b]];
                break;
            }
        }
    }
    if (!pair) {
        notify("没有可安全交换的两个已连接输入", "warn");
        return false;
    }

    graphChanged(() => {
        node.disconnectInput(pair[0].index);
        node.disconnectInput(pair[1].index);
        pair[0].snapshot.origin.connect(pair[0].snapshot.originSlot, node, pair[1].index);
        pair[1].snapshot.origin.connect(pair[1].snapshot.originSlot, node, pair[0].index);
    });
    notify(`已交换 ${pair[0].input.name} / ${pair[1].input.name}`, "success");
    return true;
}

function toggleBypass() {
    const nodes = focusedNodes(1);
    if (!nodes.length) {
        notify("请选择节点", "warn");
        return false;
    }
    const restore = nodes.every((node) => node.mode === BYPASS_MODE);
    graphChanged(() => {
        for (const node of nodes) node.mode = restore ? ALWAYS_MODE : BYPASS_MODE;
    });
    notify(restore ? "已恢复所选节点" : "已旁路所选节点", "success");
    return true;
}

function arrangeSelection() {
    const nodes = selectedNodes();
    if (nodes.length < 2) {
        notify("请至少选择两个节点", "warn");
        return false;
    }

    const nodeSet = new Set(nodes.map((node) => String(node.id)));
    const incoming = new Map(nodes.map((node) => [String(node.id), 0]));
    const outgoing = new Map(nodes.map((node) => [String(node.id), []]));
    for (const node of nodes) {
        for (const output of node.outputs ?? []) {
            for (const linkId of output.links ?? []) {
                const link = app.graph.links?.[linkId];
                if (!link || !nodeSet.has(String(link.target_id))) continue;
                outgoing.get(String(node.id)).push(String(link.target_id));
                incoming.set(String(link.target_id), incoming.get(String(link.target_id)) + 1);
            }
        }
    }

    const levels = new Map();
    const queue = nodes
        .filter((node) => incoming.get(String(node.id)) === 0)
        .sort((a, b) => a.pos[1] - b.pos[1])
        .map((node) => String(node.id));
    while (queue.length) {
        const id = queue.shift();
        const level = levels.get(id) ?? 0;
        for (const targetId of outgoing.get(id) ?? []) {
            levels.set(targetId, Math.max(levels.get(targetId) ?? 0, level + 1));
            incoming.set(targetId, incoming.get(targetId) - 1);
            if (incoming.get(targetId) === 0) queue.push(targetId);
        }
    }
    for (const node of nodes) {
        const id = String(node.id);
        if (!levels.has(id)) levels.set(id, Math.max(0, Math.round(node.pos[0] / 300)));
    }

    const oldCenter = nodes.reduce((acc, node) => [acc[0] + node.pos[0], acc[1] + node.pos[1]], [0, 0]);
    oldCenter[0] /= nodes.length;
    oldCenter[1] /= nodes.length;
    const columns = new Map();
    for (const node of nodes) {
        const level = levels.get(String(node.id));
        if (!columns.has(level)) columns.set(level, []);
        columns.get(level).push(node);
    }

    let x = 0;
    const positions = new Map();
    for (const level of [...columns.keys()].sort((a, b) => a - b)) {
        const column = columns.get(level).sort((a, b) => a.pos[1] - b.pos[1]);
        const width = Math.max(...column.map((node) => node.size?.[0] ?? 180));
        let y = 0;
        for (const node of column) {
            positions.set(node, [x, y]);
            y += (node.size?.[1] ?? 100) + 55;
        }
        const height = y - 55;
        for (const node of column) positions.get(node)[1] -= height / 2;
        x += width + 110;
    }

    const newCenter = [...positions.values()].reduce((acc, pos) => [acc[0] + pos[0], acc[1] + pos[1]], [0, 0]);
    newCenter[0] /= nodes.length;
    newCenter[1] /= nodes.length;
    graphChanged(() => {
        for (const [node, pos] of positions) {
            node.pos[0] = pos[0] + oldCenter[0] - newCenter[0];
            node.pos[1] = pos[1] + oldCenter[1] - newCenter[1];
        }
    });
    notify(`已按数据流整理 ${nodes.length} 个节点`, "success");
    return true;
}

function addReroutesAfterSelection() {
    const nodes = focusedNodes(1);
    const rerouteType = LiteGraph.registered_node_types?.Reroute ? "Reroute" : null;
    if (!nodes.length || !rerouteType) {
        notify(rerouteType ? "请选择节点" : "当前前端没有可用的 Reroute 节点", "warn");
        return false;
    }
    let created = 0;
    graphChanged(() => {
        for (const source of nodes) {
            for (let outputIndex = 0; outputIndex < (source.outputs?.length ?? 0); outputIndex++) {
                const output = source.outputs[outputIndex];
                const links = (output.links ?? [])
                    .map((id) => app.graph.links?.[id])
                    .filter(Boolean)
                    .map((link) => ({ targetId: link.target_id, targetSlot: link.target_slot }));
                if (!links.length) continue;

                const reroute = LiteGraph.createNode(rerouteType);
                if (!reroute) continue;
                app.graph.add(reroute);
                reroute.pos = [
                    source.pos[0] + (source.size?.[0] ?? 180) + 65,
                    source.pos[1] + 35 + outputIndex * 28,
                ];
                source.disconnectOutput(outputIndex);
                source.connect(outputIndex, reroute, 0);
                for (const link of links) reroute.connect(0, link.targetId, link.targetSlot);
                created++;
            }
        }
    });
    notify(created ? `已插入 ${created} 个扇出中继点` : "所选节点没有输出连线", created ? "success" : "warn");
    return created > 0;
}

function commandOptions() {
    return [
        { content: "全局匹配并连接所选节点", callback: smartConnectSelection },
        { content: "交换当前节点的两个输入", callback: swapLinkedInputs },
        { content: "插入输出中继点", callback: addReroutesAfterSelection },
        { content: "按数据流整理所选节点", callback: arrangeSelection },
        null,
        { content: "旁路 / 恢复所选节点", callback: toggleBypass },
    ];
}

function showCommandMenu(event = null) {
    const menuEvent = event ?? new MouseEvent("contextmenu", {
        clientX: lastPointer.clientX,
        clientY: lastPointer.clientY,
        bubbles: true,
    });
    new LiteGraph.ContextMenu(commandOptions(), {
        event: menuEvent,
        title: "Flow Wrangler",
    });
}

function patchCanvasMenu() {
    if (LGraphCanvas.prototype.__flowWranglerMenuPatched) return;
    LGraphCanvas.prototype.__flowWranglerMenuPatched = true;
    const original = LGraphCanvas.prototype.getCanvasMenuOptions;
    LGraphCanvas.prototype.getCanvasMenuOptions = function () {
        const options = original?.apply(this, arguments) ?? [];
        options.push(null, {
            content: "Flow Wrangler",
            has_submenu: true,
            submenu: { title: "Flow Wrangler", options: commandOptions() },
        });
        return options;
    };
}

function patchNodeMenus(nodeType) {
    const original = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_, options) {
        original?.apply(this, arguments);
        options.unshift({
            content: "Flow Wrangler",
            has_submenu: true,
            submenu: { title: "Flow Wrangler", options: commandOptions() },
        });
    };
}

function ensureGestureOverlay() {
    if (gestureOverlay) return gestureOverlay;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:99999;pointer-events:none;display:none";
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("stroke", "#6ee7ff");
    line.setAttribute("stroke-width", "3");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-dasharray", "8 6");
    line.style.filter = "drop-shadow(0 0 4px #22d3ee)";
    svg.appendChild(line);
    document.body.appendChild(svg);
    gestureOverlay = { svg, line };
    return gestureOverlay;
}

function eventPosition(event) {
    try {
        return app.canvas.convertEventToCanvasOffset(event);
    } catch (_) {
        return app.canvas.graph_mouse;
    }
}

function nodeAtEvent(event) {
    const pos = eventPosition(event);
    return app.graph?.getNodeOnPos?.(pos[0], pos[1], app.graph._nodes, 5) ?? null;
}

function installLazyConnectGesture() {
    const canvasElement = app.canvas?.canvas;
    if (!canvasElement || canvasElement.__flowWranglerGestureInstalled) return;
    canvasElement.__flowWranglerGestureInstalled = true;
    const overlay = ensureGestureOverlay();

    canvasElement.addEventListener("pointermove", (event) => {
        lastPointer = { clientX: event.clientX, clientY: event.clientY };
    }, true);

    canvasElement.addEventListener("pointerdown", (event) => {
        if (!gestureEnabled || event.button !== 2 || !event.altKey) {
            if (pendingClickSource) {
                pendingClickSource = null;
                overlay.svg.style.display = "none";
            }
            return;
        }
        const source = nodeAtEvent(event);
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!source) {
            pendingClickSource = null;
            overlay.svg.style.display = "none";
            suppressContextMenuUntil = performance.now() + 350;
            notify("已取消 Alt + 右键连接", "info");
            return;
        }
        lazyGesture = { source, startX: event.clientX, startY: event.clientY, moved: false };
        overlay.svg.style.display = "block";
        if (!pendingClickSource) {
            overlay.line.setAttribute("x1", String(event.clientX));
            overlay.line.setAttribute("y1", String(event.clientY));
        }
        overlay.line.setAttribute("x2", String(event.clientX));
        overlay.line.setAttribute("y2", String(event.clientY));
    }, true);

    window.addEventListener("pointermove", (event) => {
        if (lazyGesture) {
            const distance = Math.hypot(event.clientX - lazyGesture.startX, event.clientY - lazyGesture.startY);
            if (!lazyGesture.moved && distance > 6) {
                lazyGesture.moved = true;
                pendingClickSource = null;
                overlay.line.setAttribute("x1", String(lazyGesture.startX));
                overlay.line.setAttribute("y1", String(lazyGesture.startY));
            }
        } else if (!pendingClickSource) {
            return;
        }
        overlay.line.setAttribute("x2", String(event.clientX));
        overlay.line.setAttribute("y2", String(event.clientY));
    }, true);

    window.addEventListener("pointerup", (event) => {
        if (!lazyGesture || event.button !== 2) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const gesture = lazyGesture;
        lazyGesture = null;
        suppressContextMenuUntil = performance.now() + 350;
        const target = nodeAtEvent(event);

        if (!gesture.moved) {
            const clickedNode = target ?? gesture.source;
            if (!pendingClickSource) {
                pendingClickSource = {
                    node: clickedNode,
                    clientX: event.clientX,
                    clientY: event.clientY,
                };
                overlay.svg.style.display = "block";
                overlay.line.setAttribute("x1", String(event.clientX));
                overlay.line.setAttribute("y1", String(event.clientY));
                overlay.line.setAttribute("x2", String(event.clientX));
                overlay.line.setAttribute("y2", String(event.clientY));
                notify(`已选择源节点：${clickedNode.title ?? clickedNode.type}；再 Alt + 右键目标节点`, "info");
                return;
            }

            const source = pendingClickSource.node;
            pendingClickSource = null;
            overlay.svg.style.display = "none";
            if (!clickedNode || clickedNode === source) {
                notify("已取消 Alt + 右键连接", "info");
                return;
            }
            let connected = false;
            graphChanged(() => {
                connected = smartConnectBetween(source, clickedNode, true);
            });
            notify(connected ? "Alt + 右键连接完成" : "两个节点之间没有兼容插槽", connected ? "success" : "warn");
            return;
        }

        pendingClickSource = null;
        overlay.svg.style.display = "none";
        if (!target || target === gesture.source) return;
        let connected = false;
        graphChanged(() => {
            connected = smartConnectBetween(gesture.source, target, true);
        });
        notify(connected ? "Alt + 右键拖动连接完成" : "两个节点之间没有兼容插槽", connected ? "success" : "warn");
    }, true);

    canvasElement.addEventListener("contextmenu", (event) => {
        if (lazyGesture || performance.now() < suppressContextMenuUntil || (pendingClickSource && event.altKey)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
}

app.registerExtension({
    name: EXTENSION_NAME,

    commands: [
        { id: "flow-wrangler.smart-connect", label: "Flow Wrangler: 全局匹配并连接所选节点", function: smartConnectSelection },
        { id: "flow-wrangler.swap-inputs", label: "Flow Wrangler: 交换输入", function: swapLinkedInputs },
        { id: "flow-wrangler.add-reroutes", label: "Flow Wrangler: 插入输出中继点", function: addReroutesAfterSelection },
        { id: "flow-wrangler.arrange", label: "Flow Wrangler: 整理所选节点", function: arrangeSelection },
        { id: "flow-wrangler.toggle-bypass", label: "Flow Wrangler: 旁路 / 恢复节点", function: toggleBypass },
        { id: "flow-wrangler.show-menu", label: "Flow Wrangler: 打开快捷菜单", function: showCommandMenu },
    ],

    keybindings: [
        {
            combo: { shift: true, key: "w" },
            commandId: "flow-wrangler.smart-connect",
            targetElementId: "graph-canvas-container",
        },
        {
            combo: { shift: true, key: "s" },
            commandId: "flow-wrangler.swap-inputs",
            targetElementId: "graph-canvas-container",
        },
    ],

    settings: [
        {
            id: SETTING_GESTURE,
            name: "Flow Wrangler：启用 Alt + 右键点选 / 拖动智能连接",
            type: "boolean",
            defaultValue: true,
            onChange(value) { gestureEnabled = value !== false; },
        },
        {
            id: SETTING_REPLACE,
            name: "Flow Wrangler：智能连接可替换已有输入",
            type: "boolean",
            defaultValue: false,
            onChange(value) { replaceConnectedInputs = value === true; },
        },
    ],

    menuCommands: [
        {
            path: ["Edit", "Flow Wrangler"],
            commands: [
                "flow-wrangler.smart-connect",
                "flow-wrangler.swap-inputs",
                "flow-wrangler.add-reroutes",
                "flow-wrangler.arrange",
                "flow-wrangler.toggle-bypass",
            ],
        },
    ],

    async beforeRegisterNodeDef(nodeType) {
        patchNodeMenus(nodeType);
    },

    async setup() {
        gestureEnabled = app.ui.settings.getSettingValue(SETTING_GESTURE) !== false;
        replaceConnectedInputs = app.ui.settings.getSettingValue(SETTING_REPLACE) === true;
        patchCanvasMenu();
        installLazyConnectGesture();
        console.info(`[Flow Wrangler] v${EXTENSION_VERSION} loaded (modern frontend keybindings enabled)`);
    },
});
