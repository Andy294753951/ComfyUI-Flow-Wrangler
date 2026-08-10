import { app } from "../../scripts/app.js";

const EXTENSION_NAME = "Comfy.FlowWrangler";
const EXTENSION_VERSION = "0.2.5";
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

function polarityFromText(value) {
    const text = String(value ?? "").toLowerCase();
    if (!text) return "neutral";

    // Keep this deliberately conservative: generic words such as "prompt" are
    // not positive signals because both prompt encoders often keep the same
    // default title.
    if (/(^|[^a-z])(negative|neg|uncond|unconditional|uc)([^a-z]|$)/.test(text)
        || /(\u8d1f\u5411|\u8d1f\u9762|\u8d1f\u63d0\u793a|\u53cd\u5411\u63d0\u793a|\u53cd\u5411\u8bcd|\u660e\u786e\u6392\u9664|\u6392\u9664\u9879)/.test(text)) {
        return "negative";
    }
    if (/(^|[^a-z])(positive|pos)([^a-z]|$)/.test(text)
        || /(\u6b63\u5411|\u6b63\u9762|\u6b63\u63d0\u793a|\u4e3b\u63d0\u793a)/.test(text)) {
        return "positive";
    }
    return "neutral";
}

function sourcePolarity(node, outputIndex) {
    const output = node?.outputs?.[outputIndex];
    const parts = [
        node?.title,
        node?.type,
        node?.constructor?.title,
        node?.properties?.["Node name for S&R"],
        output?.name,
        output?.label,
    ];
    for (const part of parts) {
        const polarity = polarityFromText(part);
        if (polarity !== "neutral") return polarity;
    }
    return "neutral";
}

function inputPolarity(target, inputIndex) {
    const input = target?.inputs?.[inputIndex];
    // Socket names are the strongest signal: KSampler exposes explicit
    // positive/negative CONDITIONING inputs. Fall back to the target title for
    // custom nodes whose socket names are generic.
    for (const part of [input?.name, input?.label]) {
        const polarity = polarityFromText(part);
        if (polarity !== "neutral") return polarity;
    }
    for (const part of [target?.title, target?.type]) {
        const polarity = polarityFromText(part);
        if (polarity !== "neutral") return polarity;
    }
    return "neutral";
}

function conditioningPolarityScore(source, outputIndex, target, inputIndex) {
    const output = source?.outputs?.[outputIndex];
    const input = target?.inputs?.[inputIndex];
    if (!output || !input) return 0;

    const outputType = normalizeType(output.type);
    const inputType = normalizeType(input.type);
    if (!outputType.includes("CONDITIONING") || !inputType.includes("CONDITIONING")) return 0;

    const wanted = inputPolarity(target, inputIndex);
    if (wanted === "neutral") return 0;
    const offered = sourcePolarity(source, outputIndex);

    if (offered === wanted) return wanted === "negative" ? 1800 : 1400;
    if (offered !== "neutral") return -2200;
    return 0;
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
    score += conditioningPolarityScore(source, outputIndex, target, inputIndex);
    if (reusedForTarget) score -= 520;
    return score;
}

function bestGlobalCandidate(nodes, target, inputIndex, usedByTarget) {
    const candidates = [];
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
            if (score > -Infinity) {
                candidates.push({
                    source, target, outputIndex, inputIndex, score, key,
                    sourcePolarity: sourcePolarity(source, outputIndex),
                    outputY: slotPosition(source, false, outputIndex)[1],
                });
            }
        }
    }
    if (!candidates.length) return null;

    // Prefer distinct compatible sources for same-type target inputs. Reuse is
    // still allowed when only one compatible source exists.
    const unused = candidates.filter((candidate) => !usedByTarget.has(candidate.key));
    const pool = unused.length ? unused : candidates;

    // When no source has an explicit semantic label, keep vertical placement as
    // a weak fallback only. Explicit positive/negative labels remain stronger.
    const wanted = inputPolarity(target, inputIndex);
    if (wanted !== "neutral") {
        const conditioning = pool.filter((candidate) =>
            normalizeType(candidate.source.outputs?.[candidate.outputIndex]?.type).includes("CONDITIONING")
        );
        const hasExplicitMatch = conditioning.some((candidate) => candidate.sourcePolarity === wanted);
        if (!hasExplicitMatch && conditioning.length > 1) {
            const ys = conditioning.map((candidate) => candidate.outputY);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            const span = Math.max(1, maxY - minY);
            for (const candidate of conditioning) {
                if (candidate.sourcePolarity !== "neutral") continue;
                const rank = (candidate.outputY - minY) / span;
                candidate.score += wanted === "positive" ? (1 - rank) * 220 : rank * 220;
            }
        }
    }

    return pool.reduce((best, candidate) => !best || candidate.score > best.score ? candidate : best, null);
}

function smartConnectSelection() {
    const nodes = selectedNodes().sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1]);
    if (nodes.length < 2) {
        notify("Select at least two nodes", "warn");
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
        const suffix = unresolved
            ? `; ${unresolved} input${unresolved === 1 ? "" : "s"} had no compatible source in the selection`
            : "";
        notify(`Smart-connected ${connected} link${connected === 1 ? "" : "s"}${suffix}`, unresolved ? "info" : "success");
    }
    else notify("No compatible free slots were found", "warn");
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
        notify("Select a node", "warn");
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
        notify("No connected input pair can be swapped safely", "warn");
        return false;
    }

    graphChanged(() => {
        node.disconnectInput(pair[0].index);
        node.disconnectInput(pair[1].index);
        pair[0].snapshot.origin.connect(pair[0].snapshot.originSlot, node, pair[1].index);
        pair[1].snapshot.origin.connect(pair[1].snapshot.originSlot, node, pair[0].index);
    });
    notify(`Swapped ${pair[0].input.name} / ${pair[1].input.name}`, "success");
    return true;
}

function toggleBypass() {
    const nodes = focusedNodes(1);
    if (!nodes.length) {
        notify("Select one or more nodes", "warn");
        return false;
    }
    const restore = nodes.every((node) => node.mode === BYPASS_MODE);
    graphChanged(() => {
        for (const node of nodes) node.mode = restore ? ALWAYS_MODE : BYPASS_MODE;
    });
    notify(restore ? "Restored selected nodes" : "Bypassed selected nodes", "success");
    return true;
}

function arrangeSelection() {
    const nodes = selectedNodes();
    if (nodes.length < 2) {
        notify("Select at least two nodes", "warn");
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
    notify(`Arranged ${nodes.length} node${nodes.length === 1 ? "" : "s"} by data flow`, "success");
    return true;
}

function addReroutesAfterSelection() {
    const nodes = focusedNodes(1);
    const rerouteType = LiteGraph.registered_node_types?.Reroute ? "Reroute" : null;
    if (!nodes.length || !rerouteType) {
        notify(rerouteType ? "Select one or more nodes" : "No Reroute node type is available in this frontend", "warn");
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
    notify(
        created
            ? `Inserted ${created} fan-out reroute point${created === 1 ? "" : "s"}`
            : "The selected nodes have no output links",
        created ? "success" : "warn",
    );
    return created > 0;
}

function commandOptions() {
    return [
        { content: "Smart-connect selected nodes", callback: smartConnectSelection },
        { content: "Swap two inputs on the current node", callback: swapLinkedInputs },
        { content: "Insert output reroute points", callback: addReroutesAfterSelection },
        { content: "Arrange selected nodes by data flow", callback: arrangeSelection },
        null,
        { content: "Bypass / restore selected nodes", callback: toggleBypass },
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
            notify("Alt + right-click connection cancelled", "info");
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
                notify(`Source selected: ${clickedNode.title ?? clickedNode.type}. Alt + right-click a target node`, "info");
                return;
            }

            const source = pendingClickSource.node;
            pendingClickSource = null;
            overlay.svg.style.display = "none";
            if (!clickedNode || clickedNode === source) {
                notify("Alt + right-click connection cancelled", "info");
                return;
            }
            let connected = false;
            graphChanged(() => {
                connected = smartConnectBetween(source, clickedNode, true);
            });
            notify(connected ? "Alt + right-click connection completed" : "The two nodes have no compatible slots", connected ? "success" : "warn");
            return;
        }

        pendingClickSource = null;
        overlay.svg.style.display = "none";
        if (!target || target === gesture.source) return;
        let connected = false;
        graphChanged(() => {
            connected = smartConnectBetween(gesture.source, target, true);
        });
        notify(connected ? "Alt + right-drag connection completed" : "The two nodes have no compatible slots", connected ? "success" : "warn");
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
        { id: "flow-wrangler.smart-connect", label: "Flow Wrangler: Smart-connect selected nodes", function: smartConnectSelection },
        { id: "flow-wrangler.swap-inputs", label: "Flow Wrangler: Swap inputs", function: swapLinkedInputs },
        { id: "flow-wrangler.add-reroutes", label: "Flow Wrangler: Insert output reroute points", function: addReroutesAfterSelection },
        { id: "flow-wrangler.arrange", label: "Flow Wrangler: Arrange selected nodes", function: arrangeSelection },
        { id: "flow-wrangler.toggle-bypass", label: "Flow Wrangler: Bypass / restore nodes", function: toggleBypass },
        { id: "flow-wrangler.show-menu", label: "Flow Wrangler: Open quick menu", function: showCommandMenu },
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
            name: "Flow Wrangler: Enable Alt + right-click / right-drag smart connection",
            type: "boolean",
            defaultValue: true,
            onChange(value) { gestureEnabled = value !== false; },
        },
        {
            id: SETTING_REPLACE,
            name: "Flow Wrangler: Allow smart connection to replace existing inputs",
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
