const fs = require("fs");
const path = require("path");

const pluginPath = path.resolve(__dirname, "..", "web", "flow_wrangler.js");
let source = fs.readFileSync(pluginPath, "utf8");
source = source.replace(/^import\s+\{\s*app\s*\}\s+from\s+[^;]+;\s*/m, "");

let registeredExtension = null;
let nextLinkId = 1;
const graph = {
    links: {},
    nodes: [],
    getNodeById(id) { return this.nodes.find((node) => String(node.id) === String(id)); },
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
};

function makeNode(id, type, title, x, y, inputs, outputs) {
    const node = {
        id,
        type,
        title,
        pos: [x, y],
        size: [260, 160],
        flags: { collapsed: false },
        inputs: inputs.map(([name, slotType]) => ({ name, type: slotType, link: null })),
        outputs: outputs.map(([name, slotType]) => ({ name, type: slotType, links: [] })),
        getConnectionPos(isInput, slotIndex, out) {
            out[0] = this.pos[0] + (isInput ? 0 : this.size[0]);
            out[1] = this.pos[1] + 35 + slotIndex * 20;
            return out;
        },
        disconnectInput(inputIndex) {
            const linkId = this.inputs[inputIndex].link;
            if (linkId == null) return;
            const link = graph.links[linkId];
            if (link) {
                const origin = graph.getNodeById(link.origin_id);
                origin.outputs[link.origin_slot].links = origin.outputs[link.origin_slot].links.filter((id) => id !== linkId);
                delete graph.links[linkId];
            }
            this.inputs[inputIndex].link = null;
        },
        connect(outputIndex, target, inputIndex) {
            if (typeof target !== "object") target = graph.getNodeById(target);
            const output = this.outputs[outputIndex];
            const input = target?.inputs?.[inputIndex];
            if (!output || !input || !LiteGraph.isValidConnection(output.type, input.type)) return false;
            if (input.link != null) target.disconnectInput(inputIndex);
            const linkId = nextLinkId++;
            graph.links[linkId] = {
                id: linkId,
                origin_id: this.id,
                origin_slot: outputIndex,
                target_id: target.id,
                target_slot: inputIndex,
            };
            output.links.push(linkId);
            input.link = linkId;
            return graph.links[linkId];
        },
    };
    graph.nodes.push(node);
    return node;
}

const englishConditioningOutput = [["CONDITIONING", "CONDITIONING_EN"]];
const chineseConditioningOutput = [["CONDITIONING", "CONDITIONING_ZH"]];
const neutralConditioningOutput = [["CONDITIONING", "CONDITIONING_NEUTRAL"]];
const positiveEnglish = makeNode(1, "CLIPTextEncode", "Positive Prompt", 100, 700, [], englishConditioningOutput);
const negativeEnglish = makeNode(2, "CLIPTextEncode", "Negative Prompt", 100, 100, [], englishConditioningOutput);
const englishTarget = makeNode(3, "KSampler", "English Target", 900, 300, [
    ["positive", "CONDITIONING_EN"],
    ["negative", "CONDITIONING_EN"],
], []);

const positiveChineseTitle = "\u6b63\u5411\u63d0\u793a\u8bcd";
const negativeChineseTitle = "\u8d1f\u5411\u63d0\u793a\u8bcd";
const positiveChinese = makeNode(4, "CLIPTextEncode", positiveChineseTitle, 100, 760, [], chineseConditioningOutput);
const negativeChinese = makeNode(5, "CLIPTextEncode", negativeChineseTitle, 100, 40, [], chineseConditioningOutput);
const chineseTarget = makeNode(6, "KSampler", "Chinese Target", 1200, 500, [
    ["positive", "CONDITIONING_ZH"],
    ["negative", "CONDITIONING_ZH"],
], []);

const neutralA = makeNode(7, "CLIPTextEncode", "Neutral A", 200, 300, [], neutralConditioningOutput);
const neutralB = makeNode(8, "CLIPTextEncode", "Neutral B", 220, 360, [], neutralConditioningOutput);
const neutralTarget = makeNode(9, "ConditioningPair", "Neutral Target", 1500, 700, [
    ["first", "CONDITIONING_NEUTRAL"],
    ["second", "CONDITIONING_NEUTRAL"],
], []);

const selected = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
const app = {
    graph,
    canvas: { selected_nodes: selected, current_node: graph.nodes[0], setDirty() {} },
    extensionManager: { toast: { add() {} } },
    registerExtension(extension) { registeredExtension = extension; },
};
const LiteGraph = {
    isValidConnection(outputType, inputType) {
        return outputType === inputType || outputType === "*" || inputType === "*";
    },
};
function LGraphCanvas() {}
LGraphCanvas.prototype = {};
const window = { innerWidth: 1920, innerHeight: 1080 };
const document = {};
function MouseEvent() {}
const performance = { now: () => 0 };

new Function("app", "LiteGraph", "LGraphCanvas", "window", "document", "MouseEvent", "performance", source)(
    app,
    LiteGraph,
    LGraphCanvas,
    window,
    document,
    MouseEvent,
    performance,
);

const smartCommand = registeredExtension.commands.find((command) => command.id === "flow-wrangler.smart-connect");
if (!smartCommand) throw new Error("Smart-connect command was not registered");
smartCommand.function();

function originForInput(target, inputIndex) {
    const linkId = target.inputs[inputIndex].link;
    const link = graph.links[linkId];
    return link ? graph.getNodeById(link.origin_id) : null;
}

if (originForInput(englishTarget, 0) !== positiveEnglish) {
    throw new Error("English positive CONDITIONING did not match the Positive Prompt source");
}
if (originForInput(englishTarget, 1) !== negativeEnglish) {
    throw new Error("English negative CONDITIONING did not match the Negative Prompt source");
}
if (originForInput(chineseTarget, 0) !== positiveChinese) {
    throw new Error("Localized positive CONDITIONING did not match its semantic source");
}
if (originForInput(chineseTarget, 1) !== negativeChinese) {
    throw new Error("Localized negative CONDITIONING did not match its semantic source");
}

const neutralOrigins = [originForInput(neutralTarget, 0), originForInput(neutralTarget, 1)];
if (!neutralOrigins[0] || !neutralOrigins[1] || neutralOrigins[0] === neutralOrigins[1]) {
    throw new Error("Same-type inputs reused one source while another compatible source was available");
}
if (graph.nodes.some((node) => node.flags.collapsed)) {
    throw new Error("A node was unexpectedly collapsed");
}

const smartBinding = registeredExtension.keybindings.find((binding) => binding.commandId === "flow-wrangler.smart-connect");
if (!smartBinding?.combo?.shift || smartBinding?.combo?.ctrl || smartBinding?.combo?.alt || smartBinding.combo.key !== "w") {
    throw new Error("Modern Shift+W keybinding is missing");
}

console.log(JSON.stringify({
    passed: true,
    englishSemanticMatching: true,
    localizedSemanticMatching: true,
    distinctSourceReuseAvoidance: true,
    collapsedNodes: 0,
    shortcut: "Shift+W",
}));
