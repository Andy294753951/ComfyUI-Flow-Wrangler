const fs = require("fs");
const path = require("path");

const pluginPath = path.resolve(__dirname, "..", "web", "flow_wrangler.js");
let source = fs.readFileSync(pluginPath, "utf8");
source = source.replace(/^import\s+\{\s*app\s*\}\s+from\s+[^;]+;\s*/m, "");

const examplesDir = path.resolve(__dirname, "..", "examples");
const exampleFiles = fs.readdirSync(examplesDir).filter((name) => name.endsWith(".json")).sort();

function runExample(fileName) {
    const data = JSON.parse(fs.readFileSync(path.join(examplesDir, fileName), "utf8"));
    let registeredExtension = null;
    let nextLinkId = 1;
    const graph = {
        links: {},
        nodes: [],
        getNodeById(id) { return this.nodes.find((node) => String(node.id) === String(id)); },
        beforeChange() {}, afterChange() {}, setDirtyCanvas() {},
    };

    function makeNode(raw) {
        const node = {
            ...raw,
            flags: raw.flags || {},
            inputs: (raw.inputs || []).map((input) => ({ ...input, link: null })),
            outputs: (raw.outputs || []).map((output) => ({ ...output, links: [] })),
            size: raw.size || [180, 100],
            pos: raw.pos || [0, 0],
            getConnectionPos(isInput, slotIndex, out) {
                out[0] = this.pos[0] + (isInput ? 0 : this.size[0]);
                out[1] = this.pos[1] + 35 + slotIndex * 20;
                return out;
            },
            disconnectInput(inputIndex) {
                const linkId = this.inputs[inputIndex]?.link;
                if (linkId == null) return;
                const link = graph.links[linkId];
                if (link) {
                    const origin = graph.getNodeById(link.origin_id);
                    if (origin?.outputs?.[link.origin_slot]) {
                        origin.outputs[link.origin_slot].links = origin.outputs[link.origin_slot].links.filter((id) => id !== linkId);
                    }
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
                    id: linkId, origin_id: this.id, origin_slot: outputIndex,
                    target_id: target.id, target_slot: inputIndex,
                };
                output.links.push(linkId);
                input.link = linkId;
                return graph.links[linkId];
            },
        };
        graph.nodes.push(node);
        return node;
    }

    data.nodes.map(makeNode);
    const selected = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
    const app = {
        graph,
        canvas: { selected_nodes: selected, current_node: graph.nodes[0], setDirty() {} },
        extensionManager: { toast: { add() {} } },
        registerExtension(extension) { registeredExtension = extension; },
    };
    const LiteGraph = {
        isValidConnection(a, b) {
            if (a === "*" || b === "*" || a === b) return true;
            return String(a).toUpperCase().split(",").some((x) => String(b).toUpperCase().split(",").includes(x));
        },
    };
    function LGraphCanvas() {}
    LGraphCanvas.prototype = {};
    const window = { innerWidth: 1920, innerHeight: 1080 };
    const document = {};
    function MouseEvent() {}
    const performance = { now: () => 0 };

    new Function("app", "LiteGraph", "LGraphCanvas", "window", "document", "MouseEvent", "performance", source)(
        app, LiteGraph, LGraphCanvas, window, document, MouseEvent, performance,
    );
    registeredExtension.commands.find((command) => command.id === "flow-wrangler.smart-connect").function();

    const links = Object.values(graph.links).map((link) => ({
        source: graph.getNodeById(link.origin_id),
        sourceSlot: graph.getNodeById(link.origin_id)?.outputs?.[link.origin_slot],
        target: graph.getNodeById(link.target_id),
        targetSlot: graph.getNodeById(link.target_id)?.inputs?.[link.target_slot],
    }));
    return { graph, links };
}

function hasLink(result, sourceType, targetType, targetInput) {
    return result.links.some((link) =>
        link.source?.type === sourceType && link.target?.type === targetType && link.targetSlot?.name === targetInput
    );
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const results = new Map(exampleFiles.map((file) => [file, runExample(file)]));
const find = (prefix) => exampleFiles.find((file) => file.startsWith(prefix));

const ex01 = results.get(find("01_"));
assert(hasLink(ex01, "KSampler", "VAEDecode", "samples"), "Example 01: sampler did not feed VAEDecode.samples");
assert(hasLink(ex01, "VAEDecode", "UltimateSDUpscale", "image"), "Example 01: decoded image did not feed upscale");
assert(hasLink(ex01, "IPAdapterAdvanced", "KSampler", "model"), "Example 01: IPAdapter model did not feed sampler");

const ex02 = results.get(find("02_"));
assert(hasLink(ex02, "KSampler", "VAEDecode", "samples"), "Example 02: sampler did not feed VAEDecode.samples");
assert(hasLink(ex02, "VAEDecode", "UltimateSDUpscale", "image"), "Example 02: decoded image did not feed upscale");
assert(hasLink(ex02, "VAEDecode", "PreviewImage", "images"), "Example 02: decoded image did not feed preview");
assert(!ex02.links.some((link) => link.source?.type === "OpenposePreprocessor" && link.target?.type === "UltimateSDUpscale"), "Example 02: OpenPose was incorrectly used as upscale input");

const ex03 = results.get(find("03_"));
assert(hasLink(ex03, "WanVideoSampler", "WanVideoDecode", "samples"), "Example 03: video sampler did not feed decoder");
assert(hasLink(ex03, "WanVideoDecode", "VHS_VideoCombine", "images"), "Example 03: decoded frames did not feed video combine");
assert(!ex03.links.some((link) => link.source?.type === "LoadImage" && link.target?.type === "SaveImage"), "Example 03: raw LoadImage was incorrectly used as final SaveImage source");

const ex04 = results.get(find("04_"));
assert(hasLink(ex04, "KSampler", "VAEDecode", "samples"), "Example 04: sampler did not feed VAEDecode.samples");
assert(hasLink(ex04, "WanVideoDecode", "VHS_VideoCombine", "images"), "Example 04: decoded video did not feed video combine");
assert(!ex04.links.some((link) => link.source?.type === "PreviewImage" && link.target?.type === "PreviewImage"), "Example 04: PreviewImage -> PreviewImage false chain appeared");

console.log(JSON.stringify({ passed: true, examples: exampleFiles.length, checked: ["latent provenance", "generated-image provenance", "video decode provenance", "terminal-node direction"] }));
