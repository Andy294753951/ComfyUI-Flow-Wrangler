const fs = require("fs");
const path = require("path");

const pluginPath = path.resolve(__dirname, "..", "web", "flow_wrangler.js");
let source = fs.readFileSync(pluginPath, "utf8");
source = source.replace(/^import\s+[^;]+;\s*/gm, "");

let registeredExtension = null;
let nextLinkId = 1;
const graph = {
    links: {}, nodes: [],
    getNodeById(id) { return this.nodes.find((node) => String(node.id) === String(id)); },
    beforeChange() {}, afterChange() {}, setDirtyCanvas() {},
};

function makeNode(id, type, title, x, y, inputs, outputs) {
    const node = {
        id, type, title, pos: [x, y], size: [260, 160],
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
            graph.links[linkId] = { id: linkId, origin_id: this.id, origin_slot: outputIndex, target_id: target.id, target_slot: inputIndex };
            output.links.push(linkId);
            input.link = linkId;
            return graph.links[linkId];
        },
    };
    graph.nodes.push(node);
    return node;
}

function origin(target, inputIndex) {
    const link = graph.links[target.inputs[inputIndex].link];
    return link ? graph.getNodeById(link.origin_id) : null;
}

// Branch affinity: the correct source is farther away but shares the branch label.
const branchGood = makeNode(1, "Source", "PIPE-L1 Positive", 100, 100, [], [["CONDITIONING", "CONDITIONING_BRANCH"]]);
const branchDecoy = makeNode(2, "Source", "PIPE-L2 Positive", 720, 100, [], [["CONDITIONING", "CONDITIONING_BRANCH"]]);
const branchTarget = makeNode(3, "Target", "PIPE-L1 KSampler", 1050, 100, [["positive", "CONDITIONING_BRANCH"]], []);

// Role-aware image routing: raw image should feed vision, preprocessed image should feed control.
const rawImage = makeNode(10, "LoadImage", "LANE-L3 Source Image", 100, 600, [], [["IMAGE", "IMAGE_ROLE"]]);
const depthImage = makeNode(11, "DepthPreprocessor", "LANE-L3 Depth Preprocessor", 650, 600, [["image", "IMAGE_ROLE"]], [["IMAGE", "IMAGE_ROLE"]]);
const visionTarget = makeNode(12, "CLIPVisionEncode", "LANE-L3 Vision Encode", 1100, 520, [["image", "IMAGE_ROLE"]], []);
const controlTarget = makeNode(13, "ApplyControlNet", "LANE-L3 Control Apply", 1100, 760, [["image", "IMAGE_ROLE"]], []);

// Reference/target semantics for a color-match style node.
const referenceImage = makeNode(20, "LoadImage", "SHOT-L4 Art Reference", 100, 1100, [], [["IMAGE", "IMAGE_COLOR"]]);
const upscaleImage = makeNode(21, "Upscale", "SHOT-L4 Image Upscale Result", 650, 1100, [["image", "IMAGE_COLOR"]], [["IMAGE", "IMAGE_COLOR"]]);
const colorTarget = makeNode(22, "ColorMatch", "SHOT-L4 Color Match", 1150, 1100, [["reference", "IMAGE_COLOR"], ["target", "IMAGE_COLOR"]], []);

// Refiner and adapter stage semantics.
const checkpoint = makeNode(30, "CheckpointLoader", "STAGE-L5 Checkpoint", 100, 1600, [], [["MODEL", "MODEL_STAGE"], ["CLIP", "CLIP_STAGE"]]);
const adapter = makeNode(31, "IPAdapterApply", "STAGE-L5 IPAdapter Apply", 600, 1550, [["model", "MODEL_STAGE"]], [["MODEL", "MODEL_STAGE"]]);
const baseSampler = makeNode(32, "KSampler", "STAGE-L5 Base KSampler", 1100, 1500, [["model", "MODEL_STAGE"]], []);
const refiner = makeNode(33, "RefinerLoader", "GLOBAL Refiner Model CLIP", 100, 1900, [], [["MODEL", "MODEL_REFINER"], ["CLIP", "CLIP_REFINER"]]);
const refPrompt = makeNode(34, "CLIPTextEncode", "STAGE-L6 Refiner Positive", 650, 1850, [["clip", "CLIP_REFINER"]], [["CONDITIONING", "CONDITIONING_REFINER"]]);
const refSampler = makeNode(35, "KSampler", "STAGE-L6 Refiner KSampler", 1150, 1850, [["model", "MODEL_REFINER"], ["positive", "CONDITIONING_REFINER"]], []);

// Aggregate chaining: Final Combine should consume child combines rather than raw prompts.
const rawA = makeNode(40, "CLIPTextEncode", "CHAIN-L7 Positive A", 100, 2400, [], [["CONDITIONING", "CONDITIONING_AGG"]]);
const rawB = makeNode(41, "CLIPTextEncode", "CHAIN-L7 Positive B", 100, 2600, [], [["CONDITIONING", "CONDITIONING_AGG"]]);
const combineA = makeNode(42, "ConditioningCombine", "CHAIN-L7 Combine A", 650, 2400, [["a", "CONDITIONING_AGG"]], [["CONDITIONING", "CONDITIONING_AGG"]]);
const combineB = makeNode(43, "ConditioningCombine", "CHAIN-L7 Combine B", 650, 2650, [["a", "CONDITIONING_AGG"]], [["CONDITIONING", "CONDITIONING_AGG"]]);
const finalCombine = makeNode(44, "ConditioningCombine", "CHAIN-L7 Final Positive Combine", 1150, 2500, [["conditioning_1", "CONDITIONING_AGG"], ["conditioning_2", "CONDITIONING_AGG"]], []);

// Upstream preference: a downstream result must not wire backwards when an upstream source exists.
const upstreamVideo = makeNode(50, "VideoDecode", "PAIR-L8 Upstream Video", 600, 3100, [], [["VIDEO", "VIDEO_DIRECTION"]]);
const frameTarget = makeNode(51, "VideoFrames", "PAIR-L8 Frames", 1100, 3100, [["video", "VIDEO_DIRECTION"]], []);
const downstreamVideo = makeNode(52, "FramesToVideo", "PAIR-L8 Output Video", 1600, 3100, [], [["VIDEO", "VIDEO_DIRECTION"]]);

const selected = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
const app = {
    graph,
    canvas: { selected_nodes: selected, current_node: graph.nodes[0], setDirty() {} },
    extensionManager: { toast: { add() {} } },
    registerExtension(extension) { registeredExtension = extension; },
};
const LiteGraph = { isValidConnection(a, b) { return a === b || a === "*" || b === "*"; } };
function LGraphCanvas() {}
LGraphCanvas.prototype = {};
const window = { innerWidth: 1920, innerHeight: 1080 };
const document = {};
function MouseEvent() {}
const performance = { now: () => 0 };

new Function("app", "LiteGraph", "LGraphCanvas", "window", "document", "MouseEvent", "performance", source)(
    app, LiteGraph, LGraphCanvas, window, document, MouseEvent, performance,
);
const smartCommand = registeredExtension.commands.find((command) => command.id === "flow-wrangler.smart-connect");
smartCommand.function();

if (origin(branchTarget, 0) !== branchGood) throw new Error("Branch affinity did not beat the closer cross-branch decoy");
if (origin(visionTarget, 0) !== rawImage) throw new Error("Vision input did not prefer the raw/source image");
if (origin(controlTarget, 0) !== depthImage) throw new Error("Control input did not prefer the preprocessed image");
if (origin(colorTarget, 0) !== referenceImage || origin(colorTarget, 1) !== upscaleImage) throw new Error("Reference/target image roles were not preserved");
if (origin(baseSampler, 0) !== adapter) throw new Error("Base sampler did not prefer the adapter-processed model");
if (origin(refPrompt, 0) !== refiner || origin(refSampler, 0) !== refiner) throw new Error("Refiner stage did not prefer refiner resources");
const aggregateOrigins = new Set([origin(finalCombine, 0), origin(finalCombine, 1)]);
if (!aggregateOrigins.has(combineA) || !aggregateOrigins.has(combineB)) throw new Error("Final aggregate did not prefer child aggregate outputs");
if (origin(frameTarget, 0) !== upstreamVideo) throw new Error("Downstream source was allowed to wire backwards despite an upstream candidate");

console.log(JSON.stringify({
    passed: true,
    branchAffinity: true,
    roleAwareImageRouting: true,
    referenceTargetRoles: true,
    refinerAndAdapterStages: true,
    aggregateChaining: true,
    upstreamPreference: true,
}));
