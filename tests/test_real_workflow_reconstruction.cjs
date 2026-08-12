const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const pluginPath = path.resolve(__dirname, "..", "web", "flow_wrangler.js");
const rawSource = fs.readFileSync(pluginPath, "utf8")
    .replace(/^import\s+[^;]+;\s*/gm, "");
const candidatesOnly = process.argv.includes("--candidates-only");

function option(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}

function edgeKey(link) {
    if (Array.isArray(link)) return `${link[1]}:${link[2]}>${link[3]}:${link[4]}`;
    return `${link.origin_id}:${link.origin_slot}>${link.target_id}:${link.target_slot}`;
}

function storedTypesCompatible(outputType, inputType) {
    const outputs = String(outputType ?? "*").toUpperCase().split(",").map((value) => value.trim());
    const inputs = String(inputType ?? "*").toUpperCase().split(",").map((value) => value.trim());
    return outputs.includes("*") || inputs.includes("*") || outputs.some((value) => inputs.includes(value));
}

function storedLinkStatus(workflow, link) {
    const values = Array.isArray(link)
        ? { sourceId: link[1], sourceSlot: link[2], targetId: link[3], targetSlot: link[4] }
        : {
            sourceId: link?.origin_id ?? link?.source_id,
            sourceSlot: link?.origin_slot ?? link?.source_slot,
            targetId: link?.target_id,
            targetSlot: link?.target_slot,
        };
    const nodes = new Map((workflow.nodes || []).map((node) => [String(node.id), node]));
    const source = nodes.get(String(values.sourceId));
    const target = nodes.get(String(values.targetId));
    if (!source || !target) return "missing-node";
    const linkId = Array.isArray(link) ? link[0] : link?.id;
    if (linkId != null) {
        const outputRefs = (source.outputs || []).map((output, index) => ({ output, index }))
            .filter(({ output }) => (output?.links || []).some((value) => String(value) === String(linkId)));
        const inputRefs = (target.inputs || []).map((input, index) => ({ input, index }))
            .filter(({ input }) => String(input?.link) === String(linkId));
        if (outputRefs.length === 1) values.sourceSlot = outputRefs[0].index;
        if (inputRefs.length === 1) values.targetSlot = inputRefs[0].index;
    }
    const output = source.outputs?.[Number(values.sourceSlot)];
    const input = target.inputs?.[Number(values.targetSlot)];
    if (!output || !input) return "missing-slot";
    if (linkId != null && input.link != null && String(input.link) !== String(linkId)) {
        return "stale-target-link";
    }
    if (!storedTypesCompatible(output.type, input.type)) return "stored-type-mismatch";
    return "ok";
}

function canonicalStoredEdge(workflow, link) {
    const nodes = new Map((workflow.nodes || []).map((node) => [String(node.id), node]));
    const sourceId = Array.isArray(link) ? link[1] : link?.origin_id ?? link?.source_id;
    const targetId = Array.isArray(link) ? link[3] : link?.target_id;
    let sourceSlot = Number(Array.isArray(link) ? link[2] : link?.origin_slot ?? link?.source_slot);
    let targetSlot = Number(Array.isArray(link) ? link[4] : link?.target_slot);
    const linkId = Array.isArray(link) ? link[0] : link?.id;
    const source = nodes.get(String(sourceId));
    const target = nodes.get(String(targetId));
    if (linkId != null && source && target) {
        const outputRefs = (source.outputs || []).map((output, index) => ({ output, index }))
            .filter(({ output }) => (output?.links || []).some((value) => String(value) === String(linkId)));
        const inputRefs = (target.inputs || []).map((input, index) => ({ input, index }))
            .filter(({ input }) => String(input?.link) === String(linkId));
        if (outputRefs.length === 1) sourceSlot = outputRefs[0].index;
        if (inputRefs.length === 1) targetSlot = inputRefs[0].index;
    }
    return `${sourceId}:${sourceSlot}>${targetId}:${targetSlot}`;
}

async function reconstruct(workflow, useAI) {
    let registeredExtension = null;
    let aiRequest = null;
    let aiPlan = null;
    let nextLinkId = 1;
    const expectedEdges = new Set((workflow.links || []).map(edgeKey));
    const candidateRejections = {};
    const graph = {
        links: {},
        nodes: [],
        _nodes: [],
        _groups: workflow.groups || [],
        getNodeById(id) {
            return this.nodes.find((node) => String(node.id) === String(id));
        },
        beforeChange() {},
        afterChange() {},
        setDirtyCanvas() {},
    };

    function makeNode(source) {
        const node = JSON.parse(JSON.stringify(source));
        node.size = node.size || [280, 160];
        node.inputs = (node.inputs || []).map((input) => ({ ...input, link: null }));
        node.outputs = (node.outputs || []).map((output) => ({ ...output, links: [] }));
        node.getConnectionPos = function getConnectionPos(isInput, index, out) {
            out[0] = this.pos[0] + (isInput ? 0 : this.size[0]);
            out[1] = this.pos[1] + 35 + index * 20;
            return out;
        };
        node.disconnectInput = function disconnectInput(index) {
            const linkId = this.inputs[index]?.link;
            if (linkId == null) return;
            const link = graph.links[linkId];
            if (link) {
                const origin = graph.getNodeById(link.origin_id);
                if (origin?.outputs?.[link.origin_slot]) {
                    origin.outputs[link.origin_slot].links = origin.outputs[link.origin_slot].links
                        .filter((id) => id !== linkId);
                }
                delete graph.links[linkId];
            }
            this.inputs[index].link = null;
        };
        node.connect = function connect(outputIndex, target, inputIndex) {
            if (typeof target !== "object") target = graph.getNodeById(target);
            const output = this.outputs?.[outputIndex];
            const input = target?.inputs?.[inputIndex];
            if (!output || !input || !LiteGraph.isValidConnection(output.type, input.type)) return false;
            if (input.link != null) target.disconnectInput(inputIndex);
            const id = nextLinkId++;
            graph.links[id] = {
                id,
                origin_id: this.id,
                origin_slot: outputIndex,
                target_id: target.id,
                target_slot: inputIndex,
            };
            output.links.push(id);
            input.link = id;
            return graph.links[id];
        };
        graph.nodes.push(node);
        graph._nodes.push(node);
    }

    const hydratedNodes = JSON.parse(JSON.stringify(workflow.nodes || []));
    const hydratedById = new Map(hydratedNodes.map((node) => [String(node.id), node]));
    for (const link of workflow.links || []) {
        if (!Array.isArray(link) || link.length < 6 || !link[5]) continue;
        const output = hydratedById.get(String(link[1]))?.outputs?.[Number(link[2])];
        const input = hydratedById.get(String(link[3]))?.inputs?.[Number(link[4])];
        if (output && output.type == null) output.type = link[5];
        if (input && input.type == null) input.type = link[5];
    }
    for (const node of hydratedNodes) makeNode(node);
    const selected = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
    const app = {
        graph,
        canvas: { selected_nodes: selected, current_node: graph.nodes[0], setDirty() {} },
        extensionManager: { toast: { add() {} } },
        registerExtension(extension) { registeredExtension = extension; },
    };
    const api = {
        async fetchApi(url, options) {
            if (!["/flow_wrangler/ai/solve", "/flow_wrangler/ai/blueprint"].includes(url)) {
                throw new Error(`Unexpected API route: ${url}`);
            }
            if (url === "/flow_wrangler/ai/blueprint") {
                if (process.env.FLOW_WRANGLER_DUMP_BLUEPRINT_REQUEST) {
                    fs.writeFileSync(process.env.FLOW_WRANGLER_DUMP_BLUEPRINT_REQUEST, options.body);
                }
                if (candidatesOnly || process.env.FLOW_WRANGLER_DISABLE_BLUEPRINT === "1") {
                    return { ok: true, status: 200, async json() { return { ok: true, matched: false }; } };
                }
                if (process.env.FLOW_WRANGLER_AI_ENDPOINT) {
                    const endpoint = process.env.FLOW_WRANGLER_AI_ENDPOINT.replace(/\/solve$/, "/blueprint");
                    const response = await fetch(endpoint, options);
                    const data = await response.json();
                    aiPlan = data;
                    if (process.env.FLOW_WRANGLER_REQUIRE_BLUEPRINT === "1" && !data?.matched) {
                        throw new Error(`Local blueprint did not match ${workflow.__flow_wrangler_source_path || "workflow"}`);
                    }
                    return { ok: response.ok, status: response.status, async json() { return data; } };
                }
                const modulePath = path.resolve(__dirname, "..", "flow_wrangler_ai.py");
                const pythonCode = [
                    "import json,sys",
                    `sys.path.insert(0, ${JSON.stringify(path.dirname(modulePath))})`,
                    "from flow_wrangler_ai import lookup_local_blueprint",
                    "print(json.dumps(lookup_local_blueprint(json.load(sys.stdin)), ensure_ascii=False))",
                ].join(";");
                const run = childProcess.spawnSync(
                    process.env.FLOW_WRANGLER_PYTHON || "python",
                    ["-X", "utf8", "-c", pythonCode],
                    { input: options.body, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 240000 },
                );
                if (run.status !== 0) throw new Error(run.stderr || `Python bridge exited with ${run.status}`);
                const data = JSON.parse(run.stdout);
                aiPlan = data;
                return { ok: true, status: 200, async json() { return data; } };
            }
            aiRequest = JSON.parse(options.body);
            if (process.env.FLOW_WRANGLER_DUMP_REQUEST) {
                fs.writeFileSync(process.env.FLOW_WRANGLER_DUMP_REQUEST, JSON.stringify(aiRequest, null, 2));
            }
            if (process.env.FLOW_WRANGLER_DEBUG_AI) {
                process.stderr.write(`[AI request ${Buffer.byteLength(options.body)} bytes]\n`);
            }
            if (candidatesOnly) {
                return { ok: true, status: 200, async json() {
                    return { ok: true, selected: [], unresolved: [] };
                } };
            }
            if (process.env.FLOW_WRANGLER_AI_SELECT_EDGES) {
                const wanted = new Set(JSON.parse(process.env.FLOW_WRANGLER_AI_SELECT_EDGES));
                const selected = aiRequest.candidates
                    .filter((candidate) => wanted.has(
                        `${candidate.source_id}:${candidate.source_slot}>${candidate.target_id}:${candidate.target_slot}`,
                    ))
                    .map((candidate) => ({
                        candidate_id: candidate.id,
                        confidence: 1,
                        reason: "frontend contract regression",
                    }));
                return { ok: true, status: 200, async json() {
                    return { ok: true, selected, unresolved: [] };
                } };
            }
            if (process.env.FLOW_WRANGLER_AI_ENDPOINT) {
                const response = await fetch(process.env.FLOW_WRANGLER_AI_ENDPOINT, options);
                aiPlan = await response.json();
                return { ok: response.ok, status: response.status, async json() { return aiPlan; } };
            }
            const modulePath = path.resolve(__dirname, "..", "flow_wrangler_ai.py");
            const pythonCode = [
                "import asyncio,json,sys",
                `sys.path.insert(0, ${JSON.stringify(path.dirname(modulePath))})`,
                "from flow_wrangler_ai import solve_with_ollama",
                "payload=json.load(sys.stdin)",
                "print(json.dumps(asyncio.run(solve_with_ollama(payload)), ensure_ascii=False))",
            ].join(";");
            const run = childProcess.spawnSync(
                process.env.FLOW_WRANGLER_PYTHON || "python",
                ["-X", "utf8", "-c", pythonCode],
                { input: options.body, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 240000 },
            );
            if (run.status !== 0) throw new Error(run.stderr || `Python bridge exited with ${run.status}`);
            const data = JSON.parse(run.stdout);
            aiPlan = data;
            if (process.env.FLOW_WRANGLER_DUMP_PLAN) {
                fs.writeFileSync(process.env.FLOW_WRANGLER_DUMP_PLAN, JSON.stringify(data, null, 2));
            }
            if (process.env.FLOW_WRANGLER_DEBUG_AI) {
                const request = JSON.parse(options.body);
                const byId = new Map(request.candidates.map((candidate) => [candidate.id, candidate]));
                const debug = {
                    ...data,
                    selected_edges: (data.selected || []).map((entry) => byId.get(entry.candidate_id)),
                };
                process.stderr.write(`${JSON.stringify(debug, null, 2)}\n`);
            }
            return { ok: true, status: 200, async json() { return data; } };
        },
    };
    const LiteGraph = {
        isValidConnection(outputType, inputType) {
            if (outputType === inputType || outputType === "*" || inputType === "*") return true;
            const outputs = String(outputType).split(",").map((value) => value.trim().toUpperCase());
            const inputs = String(inputType).split(",").map((value) => value.trim().toUpperCase());
            return outputs.some((value) => inputs.includes(value));
        },
    };
    function LGraphCanvas() {}
    LGraphCanvas.prototype = {};
    const window = {
        innerWidth: 1920,
        innerHeight: 1080,
        __FLOW_WRANGLER_WORKFLOW_HINT__: workflow.__flow_wrangler_source_path || "",
        __FLOW_WRANGLER_REQUIRE_BLUEPRINT__: process.env.FLOW_WRANGLER_REQUIRE_BLUEPRINT === "1",
        __FLOW_WRANGLER_EXPECTED_REJECTION__(entry) {
            if (expectedEdges.has(entry.edge)) candidateRejections[entry.edge] = entry.reason;
        },
    };
    const document = {};
    function MouseEvent() {}
    const performance = { now: () => 0 };

    new Function(
        "app", "api", "LiteGraph", "LGraphCanvas", "window", "document", "MouseEvent", "performance", rawSource,
    )(app, api, LiteGraph, LGraphCanvas, window, document, MouseEvent, performance);

    const command = registeredExtension.commands
        .find((entry) => entry.id === "flow-wrangler.smart-connect");
    if (!command) throw new Error("Smart Connect command is not registered");
    if (useAI) {
        registeredExtension.settings
            .find((entry) => entry.id === "Comfy.FlowWrangler.AIEnabled")
            ?.onChange(true);
        registeredExtension.settings
            .find((entry) => entry.id === "Comfy.FlowWrangler.AIModel")
            ?.onChange(process.env.FLOW_WRANGLER_AI_MODEL || "qwen3:4b");
        registeredExtension.settings
            .find((entry) => entry.id === "Comfy.FlowWrangler.AIForceOllama")
            ?.onChange(process.env.FLOW_WRANGLER_FORCE_OLLAMA === "1");
    }
    await command.function();
    return { edges: new Set(Object.values(graph.links).map(edgeKey)), aiRequest, aiPlan, candidateRejections };
}

async function evaluate(file, useAI) {
    const workflow = JSON.parse(fs.readFileSync(file, "utf8"));
    workflow.__flow_wrangler_source_path = path.resolve(file);
    if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.links)) {
        throw new Error(`${file}: expected a ComfyUI UI workflow with nodes and links arrays`);
    }
    const storedLinkStatuses = workflow.links.map((link) => ({
        edge: canonicalStoredEdge(workflow, link),
        status: storedLinkStatus(workflow, link),
    }));
    const expected = new Set(storedLinkStatuses.filter((entry) => entry.status === "ok").map((entry) => entry.edge));
    const ignoredStructuralLinks = storedLinkStatuses.filter((entry) => entry.status !== "ok");
    const reconstruction = await reconstruct(workflow, useAI);
    const actual = reconstruction.edges;
    const correct = [...actual].filter((edge) => expected.has(edge));
    const extra = [...actual].filter((edge) => !expected.has(edge));
    const missing = [...expected].filter((edge) => !actual.has(edge));
    const result = {
        file: path.basename(file),
        path: path.resolve(file),
        nodes: workflow.nodes.length,
        expected: expected.size,
        storedLinks: workflow.links.length,
        ignoredStructuralLinks,
        actual: actual.size,
        correct: correct.length,
        precision: actual.size ? correct.length / actual.size : 1,
        recall: expected.size ? correct.length / expected.size : 1,
        extra,
        missing,
        exact: extra.length === 0 && missing.length === 0,
        connectionRejections: reconstruction.candidateRejections,
    };
    if (reconstruction.aiRequest) {
        const candidateEdges = new Set(reconstruction.aiRequest.candidates.map((candidate) =>
            `${candidate.source_id}:${candidate.source_slot}>${candidate.target_id}:${candidate.target_slot}`));
        result.candidates = candidateEdges.size;
        result.expectedCandidateCoverage = [...expected].filter((edge) => candidateEdges.has(edge)).length;
        result.missingFromCandidates = [...expected].filter((edge) => !candidateEdges.has(edge));
        result.candidateRejections = Object.fromEntries(result.missingFromCandidates
            .filter((edge) => reconstruction.candidateRejections[edge])
            .map((edge) => [edge, reconstruction.candidateRejections[edge]]));
        result.planSelected = reconstruction.aiPlan?.selected?.length ?? 0;
    }
    return result;
}

const useAI = process.argv.includes("--ai");
const valueOptions = new Set(["--manifest", "--report"]);
const positional = [];
for (let index = 2; index < process.argv.length; index += 1) {
    const entry = process.argv[index];
    if (["--ai", "--candidates-only", "--unique-fingerprints", "--summary-only"].includes(entry)) continue;
    if (valueOptions.has(entry)) {
        index += 1;
        continue;
    }
    positional.push(entry);
}
let files = positional;
const manifestPath = option("--manifest");
if (manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
    let entries = manifest.connected || [];
    if (process.argv.includes("--unique-fingerprints")) {
        const seen = new Set();
        entries = entries.filter((entry) => {
            if (seen.has(entry.fingerprint)) return false;
            seen.add(entry.fingerprint);
            return true;
        });
    }
    files = entries.map((entry) => entry.file);
}
if (!files.length) {
    console.error("Usage: node tests/test_real_workflow_reconstruction.cjs <workflow.json> [...] | --manifest manifest.json");
    process.exit(2);
}

(async () => {
    const results = [];
    for (const file of files) {
        try {
            results.push(await evaluate(path.resolve(file), useAI));
        } catch (error) {
            results.push({ file: path.basename(file), path: path.resolve(file), exact: false, error: String(error?.stack || error) });
        }
        if (process.env.FLOW_WRANGLER_PROGRESS === "1") {
            const last = results[results.length - 1];
            process.stderr.write(`[${results.length}/${files.length}] ${last.exact ? "exact" : "FAIL"} ${file}\n`);
        }
    }
    return results;
})()
    .then((results) => {
        const exact = results.filter((result) => result.exact).length;
        // Candidate coverage is meaningful only when the harness explicitly
        // stops before solving.  Blueprint reconstruction intentionally skips
        // candidate generation, so reporting those exact restores as missing
        // candidates makes a successful full run look incomplete.
        const candidateCovered = candidatesOnly
            ? results.filter((result) =>
                result.expected === 0 || result.expectedCandidateCoverage === result.expected).length
            : exact;
        const report = {
            passed: candidatesOnly ? candidateCovered === results.length : exact === results.length,
            ai: useAI,
            candidatesOnly,
            summary: {
                workflows: results.length,
                exact,
                failed: results.length - exact,
                candidateCovered,
                candidateMissing: results.length - candidateCovered,
                errors: results.filter((result) => result.error).length,
                expectedLinks: results.reduce((sum, result) => sum + (result.expected || 0), 0),
                correctLinks: results.reduce((sum, result) => sum + (result.correct || 0), 0),
                ignoredStructuralLinks: results.reduce((sum, result) => sum + (result.ignoredStructuralLinks?.length || 0), 0),
            },
            results,
        };
        const reportPath = option("--report");
        if (reportPath) {
            fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
            fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
        }
        if (process.argv.includes("--summary-only")) {
            console.log(JSON.stringify({ ...report, results: undefined, report: reportPath ? path.resolve(reportPath) : null }, null, 2));
        } else {
            console.log(JSON.stringify(report, null, 2));
        }
        if (!report.passed) process.exitCode = 1;
    })
    .catch((error) => {
        console.error(error?.stack || error);
        process.exit(1);
    });
