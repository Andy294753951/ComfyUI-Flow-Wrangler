const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function argument(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}

function linkEdge(link) {
    if (Array.isArray(link) && link.length >= 5) {
        return `${link[1]}:${link[2]}>${link[3]}:${link[4]}`;
    }
    if (link && typeof link === "object") {
        const source = link.origin_id ?? link.source_id;
        const sourceSlot = link.origin_slot ?? link.source_slot;
        const target = link.target_id;
        const targetSlot = link.target_slot;
        if ([source, sourceSlot, target, targetSlot].every((value) => value != null)) {
            return `${source}:${sourceSlot}>${target}:${targetSlot}`;
        }
    }
    return null;
}

function isWorkflow(value) {
    return value && typeof value === "object"
        && Array.isArray(value.nodes)
        && Array.isArray(value.links)
        && value.nodes.length > 0
        && value.nodes.every((node) => node && typeof node === "object" && node.id != null);
}

function fingerprint(workflow) {
    const normalized = {
        nodes: workflow.nodes.map((node) => ({
            id: String(node.id),
            type: String(node.type || ""),
            inputs: (node.inputs || []).map((input) => [String(input.name || ""), String(input.type || "")]),
            outputs: (node.outputs || []).map((output) => [String(output.name || ""), String(output.type || "")]),
        })),
        links: workflow.links.map(linkEdge).filter(Boolean).sort(),
    };
    return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

const output = argument("--output");
if (!output) {
    console.error("Usage: <paths on stdin> | node discover_local_workflows.cjs --output manifest.json");
    process.exit(2);
}

const paths = fs.readFileSync(0, "utf8")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
const manifest = {
    generated_at: new Date().toISOString(),
    scanned_node_json_files: paths.length,
    connected: [],
    unconnected: [],
    malformed_workflow_json: [],
    matched_but_not_workflow: [],
};

for (const file of paths) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
        manifest.malformed_workflow_json.push({ file, error: String(error.message || error) });
        continue;
    }
    if (!isWorkflow(value)) {
        manifest.matched_but_not_workflow.push(file);
        continue;
    }
    const entry = {
        file: path.resolve(file),
        nodes: value.nodes.length,
        links: value.links.length,
        valid_links: value.links.map(linkEdge).filter(Boolean).length,
        fingerprint: fingerprint(value),
    };
    (entry.valid_links > 0 ? manifest.connected : manifest.unconnected).push(entry);
}

manifest.connected.sort((a, b) => a.file.localeCompare(b.file));
manifest.unconnected.sort((a, b) => a.file.localeCompare(b.file));
manifest.summary = {
    connected: manifest.connected.length,
    unconnected: manifest.unconnected.length,
    malformed: manifest.malformed_workflow_json.length,
    matched_but_not_workflow: manifest.matched_but_not_workflow.length,
    connected_nodes: manifest.connected.reduce((sum, entry) => sum + entry.nodes, 0),
    connected_links: manifest.connected.reduce((sum, entry) => sum + entry.valid_links, 0),
    unique_connected_fingerprints: new Set(manifest.connected.map((entry) => entry.fingerprint)).size,
};
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output: path.resolve(output), ...manifest.summary }, null, 2));
