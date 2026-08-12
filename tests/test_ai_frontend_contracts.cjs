const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const harness = path.resolve(__dirname, "test_real_workflow_reconstruction.cjs");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-wrangler-contracts-"));

function node(id, type, title, pos, inputs, outputs) {
    return {
        id, type, title, pos, size: [280, 180], flags: {}, order: id, mode: 0,
        inputs: inputs.map(([name, slotType, optional = false, widget = false]) => ({
            name,
            type: slotType,
            ...(optional ? { shape: 7 } : {}),
            ...(widget ? { widget: { name } } : {}),
            link: null,
        })),
        outputs: outputs.map(([name, slotType]) => ({ name, type: slotType, links: [] })),
        widgets_values: [],
    };
}

const directoryWorkflow = {
    nodes: [
        node(1, "easy forLoopEnd", "For Loop End", [0, 0], [], [["value1", "*"]]),
        node(2, "SimpleFolderVideoCombiner", "Combine this run", [500, 0], [
            ["directory_path", "STRING", false, true],
        ], [["output_path", "STRING"]]),
    ],
    links: [[1, 1, 0, 2, 0, "STRING"]],
};

const feedbackWorkflow = {
    nodes: [
        node(10, "MiniMaxH3MotionContextTrim", "Motion Context Trim", [0, 400], [
            ["images", "IMAGE"],
            ["audio", "AUDIO", true],
        ], [
            ["images", "IMAGE"],
            ["audio", "AUDIO"],
        ]),
        node(11, "aeb9d7a6-bff6-4eea-b5a2-6029f3b21e7f", "Opaque sampler", [500, 400], [
            ["latent_image", "LATENT"],
            ["model", "MODEL"],
            ["conditioning", "CONDITIONING"],
            ["images", "IMAGE"],
            ["audio", "AUDIO", true],
        ], [
            ["output", "LATENT"],
            ["IMAGE", "IMAGE"],
            ["AUDIO", "AUDIO"],
        ]),
    ],
    links: [
        [1, 11, 1, 10, 0, "IMAGE"],
        [2, 11, 2, 10, 1, "AUDIO"],
        [3, 10, 0, 11, 3, "IMAGE"],
        [4, 10, 1, 11, 4, "AUDIO"],
    ],
};

const branchWorkflow = {
    nodes: [
        node(20, "LoadImage", "Upper reference", [-400, 1040], [], [["IMAGE", "IMAGE"]]),
        node(21, "LoadImage", "Lower reference", [-470, 1080], [], [["IMAGE", "IMAGE"]]),
        node(22, "ImageConcatMulti", "Reference pair", [0, 1100], [
            ["image_1", "IMAGE"],
            ["image_2", "IMAGE", true],
        ], [["images", "IMAGE"]]),
        node(23, "RTXVideoSuperResolution", "Continuation upscale", [500, 1450], [
            ["images", "IMAGE"],
        ], [["upscaled_images", "IMAGE"]]),
        node(24, "RTXVideoSuperResolution", "Initial upscale", [500, 1200], [
            ["images", "IMAGE"],
        ], [["upscaled_images", "IMAGE"]]),
        node(25, "VHS_VideoCombine", "Continuation output", [820, 1460], [
            ["images", "IMAGE"],
        ], [["Filenames", "VHS_FILENAMES"]]),
        node(26, "VHS_VideoCombine", "Initial save MP4", [820, 1210], [
            ["images", "IMAGE"],
        ], [["Filenames", "VHS_FILENAMES"]]),
    ],
    links: [
        [1, 20, 0, 22, 0, "IMAGE"],
        [2, 21, 0, 22, 1, "IMAGE"],
        [3, 23, 0, 25, 0, "IMAGE"],
        [4, 24, 0, 26, 0, "IMAGE"],
    ],
};

const directoryPath = path.join(temporaryDirectory, "directory.json");
const feedbackPath = path.join(temporaryDirectory, "feedback.json");
const branchPath = path.join(temporaryDirectory, "branches.json");
fs.writeFileSync(directoryPath, JSON.stringify(directoryWorkflow));
fs.writeFileSync(feedbackPath, JSON.stringify(feedbackWorkflow));
fs.writeFileSync(branchPath, JSON.stringify(branchWorkflow));

try {
    const wanted = [...directoryWorkflow.links, ...feedbackWorkflow.links, ...branchWorkflow.links]
        .map((link) => `${link[1]}:${link[2]}>${link[3]}:${link[4]}`);
    const run = childProcess.spawnSync(process.execPath, [
        harness, "--ai", directoryPath, feedbackPath, branchPath,
    ], {
        encoding: "utf8",
        env: { ...process.env, FLOW_WRANGLER_AI_SELECT_EDGES: JSON.stringify(wanted) },
        timeout: 30000,
    });
    if (run.status !== 0) throw new Error(run.stderr || `contract harness exited with ${run.status}`);
    const result = JSON.parse(run.stdout);
    for (const workflow of result.results) {
        if (workflow.precision !== 1 || workflow.recall !== 1) {
            throw new Error(`${workflow.file}: ${JSON.stringify(workflow, null, 2)}`);
        }
    }
    console.log("AI frontend contract tests passed");
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
