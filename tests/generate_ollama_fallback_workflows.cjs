const fs = require("fs");
const path = require("path");

const outputDirectory = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, "ollama_fallback_workflows");
fs.mkdirSync(outputDirectory, { recursive: true });

function input(name, type, optional = false, widget = false) {
    return {
        name,
        type,
        ...(optional ? { shape: 7 } : {}),
        ...(widget ? { widget: { name } } : {}),
        link: null,
    };
}

function output(name, type) {
    return { name, type, links: [] };
}

function node(id, type, title, x, y, inputs, outputs, widgets = []) {
    return {
        id, type, title, pos: [x, y], size: [280, Math.max(100, 70 + inputs.length * 22)],
        flags: {}, order: id, mode: 0, inputs, outputs, properties: {}, widgets_values: widgets,
    };
}

function workflow(name, nodes, edgeSpecs) {
    const byId = new Map(nodes.map((entry) => [entry.id, entry]));
    const links = edgeSpecs.map(([sourceId, sourceSlot, targetId, targetSlot], index) => {
        const linkId = index + 1;
        const source = byId.get(sourceId);
        const target = byId.get(targetId);
        const type = source.outputs[sourceSlot].type;
        source.outputs[sourceSlot].links.push(linkId);
        target.inputs[targetSlot].link = linkId;
        return [linkId, sourceId, sourceSlot, targetId, targetSlot, type];
    });
    return {
        name,
        last_node_id: Math.max(...nodes.map((entry) => entry.id)),
        last_link_id: links.length,
        nodes,
        links,
        groups: [],
        config: {},
        extra: { ds: { scale: 0.8, offset: [420, 260] } },
        version: 0.4,
    };
}

function disconnectedCopy(source) {
    const copy = JSON.parse(JSON.stringify(source));
    copy.name = `${source.name} UNCONNECTED`;
    copy.links = [];
    copy.last_link_id = 0;
    for (const entry of copy.nodes) {
        for (const slot of entry.inputs || []) slot.link = null;
        for (const slot of entry.outputs || []) slot.links = [];
    }
    return copy;
}

const controlGraph = workflow("Ollama Test 01 - Dual LoRA Control and Final Image", [
    node(1, "CheckpointLoaderSimple", "PORTRAIT | Base checkpoint", 0, 400, [], [
        output("MODEL", "MODEL"), output("CLIP", "CLIP"), output("VAE", "VAE"),
    ]),
    node(2, "LoraLoader", "PORTRAIT | Identity LoRA", 360, 320, [
        input("model", "MODEL"), input("clip", "CLIP"),
    ], [output("MODEL", "MODEL"), output("CLIP", "CLIP")]),
    node(3, "LoraLoader", "PORTRAIT | Style LoRA", 700, 320, [
        input("model", "MODEL"), input("clip", "CLIP"),
    ], [output("MODEL", "MODEL"), output("CLIP", "CLIP")]),
    node(4, "CLIPTextEncode", "PORTRAIT | Positive prompt", 1050, 160, [input("clip", "CLIP")], [output("CONDITIONING", "CONDITIONING")]),
    node(5, "CLIPTextEncode", "PORTRAIT | Negative prompt", 1050, 460, [input("clip", "CLIP")], [output("CONDITIONING", "CONDITIONING")]),
    node(6, "EmptyLatentImage", "PORTRAIT | Generation latent", 1050, 760, [], [output("LATENT", "LATENT")]),
    node(7, "LoadImage", "CONTROL | Pose reference image", 0, 1040, [], [output("IMAGE", "IMAGE"), output("MASK", "MASK")]),
    node(8, "OpenposePreprocessor", "CONTROL | Pose map", 420, 1040, [input("image", "IMAGE")], [output("IMAGE", "IMAGE")]),
    node(9, "ControlNetLoader", "CONTROL | Pose ControlNet", 700, 1210, [], [output("CONTROL_NET", "CONTROL_NET")]),
    node(10, "ControlNetApplyAdvanced", "PORTRAIT | Apply pose control", 1400, 260, [
        input("positive", "CONDITIONING"), input("negative", "CONDITIONING"),
        input("control_net", "CONTROL_NET"), input("image", "IMAGE"), input("vae", "VAE", true),
    ], [output("positive", "CONDITIONING"), output("negative", "CONDITIONING")]),
    node(11, "KSampler", "PORTRAIT | Controlled sampler", 1800, 420, [
        input("model", "MODEL"), input("positive", "CONDITIONING"), input("negative", "CONDITIONING"), input("latent_image", "LATENT"),
    ], [output("LATENT", "LATENT")]),
    node(12, "VAEDecode", "PORTRAIT | Decode generated image", 2180, 420, [input("samples", "LATENT"), input("vae", "VAE")], [output("IMAGE", "IMAGE")]),
    node(13, "ImageUpscaleWithModel", "PORTRAIT | Final upscale", 2500, 420, [input("image", "IMAGE")], [output("IMAGE", "IMAGE")]),
    node(14, "SaveImage", "PORTRAIT | Final SaveImage", 2860, 300, [input("images", "IMAGE")], []),
    node(15, "PreviewImage", "CONTROL | Pose control map preview", 920, 1080, [input("images", "IMAGE")], []),
    node(16, "PreviewImage", "PORTRAIT | Final preview", 2860, 600, [input("images", "IMAGE")], []),
], [
    [1, 0, 2, 0], [1, 1, 2, 1], [2, 0, 3, 0], [2, 1, 3, 1],
    [3, 1, 4, 0], [3, 1, 5, 0], [7, 0, 8, 0], [8, 0, 15, 0],
    [4, 0, 10, 0], [5, 0, 10, 1], [9, 0, 10, 2], [8, 0, 10, 3], [1, 2, 10, 4],
    [3, 0, 11, 0], [10, 0, 11, 1], [10, 1, 11, 2], [6, 0, 11, 3],
    [11, 0, 12, 0], [1, 2, 12, 1], [12, 0, 13, 0], [13, 0, 14, 0], [13, 0, 16, 0],
]);

const mediaGraph = workflow("Ollama Test 02 - Video Decode Audio and Control Branch", [
    node(101, "WanVideoModelLoader", "FILM | Wan video model", 0, 220, [], [output("model", "VIDEO_MODEL")]),
    node(102, "LoadWanVideoT5TextEncoder", "FILM | T5 encoder", 0, 500, [], [output("wan_t5_model", "WAN_T5")]),
    node(103, "WanVideoTextEncode", "FILM | Cinematic positive text", 400, 300, [
        input("t5", "WAN_T5"), input("model_to_offload", "VIDEO_MODEL"),
    ], [output("text_embeds", "WAN_TEXT_EMBEDS")]),
    node(104, "WanVideoEmptyEmbeds", "FILM | Empty image embeds", 400, 650, [], [output("image_embeds", "WAN_IMAGE_EMBEDS")]),
    node(105, "WanVideoSampler", "FILM | Main video sampler", 850, 380, [
        input("model", "VIDEO_MODEL"), input("text_embeds", "WAN_TEXT_EMBEDS"), input("image_embeds", "WAN_IMAGE_EMBEDS"),
    ], [output("samples", "LATENT")]),
    node(106, "WanVideoVAELoader", "FILM | Video VAE", 850, 760, [], [output("vae", "VAE")]),
    node(107, "WanVideoDecode", "FILM | Decode final frames", 1250, 400, [input("samples", "LATENT"), input("vae", "VAE")], [output("images", "IMAGE")]),
    node(108, "LoadAudio", "FILM | Final soundtrack", 1250, 760, [], [output("AUDIO", "AUDIO")]),
    node(109, "VHS_VideoCombine", "FILM | Final video with soundtrack", 1700, 420, [
        input("images", "IMAGE"), input("audio", "AUDIO", true),
    ], [output("Filenames", "VHS_FILENAMES")]),
    node(110, "LoadImage", "CONTROL | Depth reference", 0, 1050, [], [output("IMAGE", "IMAGE"), output("MASK", "MASK")]),
    node(111, "DepthAnythingPreprocessor", "CONTROL | Depth map", 420, 1050, [input("image", "IMAGE")], [output("IMAGE", "IMAGE")]),
    node(112, "PreviewImage", "CONTROL | Depth map preview", 850, 1080, [input("images", "IMAGE")], []),
    node(113, "PreviewImage", "FILM | Decoded frame preview", 1700, 760, [input("images", "IMAGE")], []),
    node(114, "SaveImage", "FILM | Contact sheet save", 2070, 700, [input("images", "IMAGE")], []),
], [
    [102, 0, 103, 0], [101, 0, 103, 1], [101, 0, 105, 0], [103, 0, 105, 1], [104, 0, 105, 2],
    [105, 0, 107, 0], [106, 0, 107, 1], [107, 0, 109, 0], [108, 0, 109, 1],
    [110, 0, 111, 0], [111, 0, 112, 0], [107, 0, 113, 0], [107, 0, 114, 0],
]);

const parallelNodes = [];
const parallelEdges = [];
for (let lane = 0; lane < 3; lane++) {
    const id = 201 + lane * 10;
    const label = ["SCENE-01", "SCENE-02", "SCENE-03"][lane];
    const y = 180 + lane * 520;
    parallelNodes.push(
        node(id, "CheckpointLoaderSimple", `${label} | Checkpoint`, 0, y, [], [output("MODEL", "MODEL"), output("CLIP", "CLIP"), output("VAE", "VAE")]),
        node(id + 1, "LoraLoaderModelOnly", `${label} | Character LoRA`, 380, y, [input("model", "MODEL")], [output("MODEL", "MODEL")]),
        node(id + 2, "CLIPTextEncode", `${label} | Positive prompt`, 720, y - 100, [input("clip", "CLIP")], [output("CONDITIONING", "CONDITIONING")]),
        node(id + 3, "CLIPTextEncode", `${label} | Negative prompt`, 720, y + 120, [input("clip", "CLIP")], [output("CONDITIONING", "CONDITIONING")]),
        node(id + 4, "EmptyLatentImage", `${label} | Latent`, 720, y + 310, [], [output("LATENT", "LATENT")]),
        node(id + 5, "KSampler", `${label} | Sampler`, 1120, y, [
            input("model", "MODEL"), input("positive", "CONDITIONING"), input("negative", "CONDITIONING"), input("latent_image", "LATENT"),
        ], [output("LATENT", "LATENT")]),
        node(id + 6, "VAEDecode", `${label} | Final decode`, 1500, y, [input("samples", "LATENT"), input("vae", "VAE")], [output("IMAGE", "IMAGE")]),
        node(id + 7, "SaveImage", `${label} | Final output`, 1850, y, [input("images", "IMAGE")], []),
    );
    parallelEdges.push(
        [id, 0, id + 1, 0], [id, 1, id + 2, 0], [id, 1, id + 3, 0],
        [id + 1, 0, id + 5, 0], [id + 2, 0, id + 5, 1], [id + 3, 0, id + 5, 2],
        [id + 4, 0, id + 5, 3], [id + 5, 0, id + 6, 0], [id, 2, id + 6, 1], [id + 6, 0, id + 7, 0],
    );
}
// Interleave the three scene lanes in storage order so a solver cannot rely on
// node-array adjacency. Canvas/title branch identity must carry the match.
parallelNodes.sort((a, b) => (a.id % 10) - (b.id % 10) || b.id - a.id);
const parallelGraph = workflow("Ollama Test 03 - Three Interleaved Scene Pipelines", parallelNodes, parallelEdges);

const suites = [controlGraph, mediaGraph, parallelGraph];
for (const [index, graph] of suites.entries()) {
    const prefix = `${String(index + 1).padStart(2, "0")}_${graph.name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
    fs.writeFileSync(path.join(outputDirectory, `${prefix}_GROUND_TRUTH.json`), `${JSON.stringify(graph, null, 2)}\n`);
    fs.writeFileSync(path.join(outputDirectory, `${prefix}_UNCONNECTED.json`), `${JSON.stringify(disconnectedCopy(graph), null, 2)}\n`);
}

console.log(JSON.stringify({ outputDirectory, workflows: suites.map((graph) => ({
    name: graph.name, nodes: graph.nodes.length, links: graph.links.length,
})) }, null, 2));
