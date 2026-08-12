"""Classify native zero-link workflows without treating zero links as truth.

Connected workflows can be disconnected and compared with their stored edges.
A file that was saved with no links has no answer key of its own.  This audit
uses an unambiguous connected workflow with the same compact topology when one
exists; otherwise it limits the verdict to endpoint/type structural safety.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import flow_wrangler_ai as ai


def normalize_type(value: Any) -> str:
    if isinstance(value, list):
        return ",".join(normalize_type(item) for item in value)
    return str("*" if value is None else value).strip().upper()


def compact_nodes(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for node in workflow.get("nodes", []):
        if not isinstance(node, dict) or "id" not in node:
            continue
        position = node.get("pos", [0, 0])
        if isinstance(position, dict):
            position = [position.get(str(index), position.get(index, 0)) for index in range(2)]
        if not isinstance(position, list):
            position = [0, 0]
        result.append({
            "id": str(node.get("id")),
            "type": str(node.get("type") or "")[:160],
            "title": str(node.get("title") if node.get("title") is not None else node.get("type") or "")[:200],
            "position": [math.floor(value + 0.5) if isinstance(value, (int, float)) else 0 for value in position[:2]],
            "inputs": [
                {
                    "index": index,
                    "name": str(slot.get("name") if slot.get("name") is not None else slot.get("label") or "")[:120],
                    "type": normalize_type(slot.get("type"))[:120],
                }
                for index, slot in enumerate((node.get("inputs") or [])[:64])
                if isinstance(slot, dict)
            ],
            "outputs": [
                {
                    "index": index,
                    "name": str(slot.get("name") if slot.get("name") is not None else slot.get("label") or "")[:120],
                    "type": normalize_type(slot.get("type"))[:120],
                }
                for index, slot in enumerate((node.get("outputs") or [])[:64])
                if isinstance(slot, dict)
            ],
        })
    return result


def edge_key(edge: dict[str, Any]) -> str:
    return (
        f"{edge['source_id']}:{edge['source_slot']}>"
        f"{edge['target_id']}:{edge['target_slot']}"
    )


def types_compatible(output_type: Any, input_type: Any) -> bool:
    outputs = {item.strip() for item in normalize_type(output_type).split(",")}
    inputs = {item.strip() for item in normalize_type(input_type).split(",")}
    return "*" in outputs or "*" in inputs or bool(outputs & inputs)


def structural_errors(workflow: dict[str, Any], actual: list[str]) -> list[str]:
    by_id = {str(node.get("id")): node for node in workflow.get("nodes", []) if isinstance(node, dict)}
    claimed = set()
    errors = []
    for value in actual:
        try:
            left, right = value.split(">", 1)
            source_id, source_slot_text = left.rsplit(":", 1)
            target_id, target_slot_text = right.rsplit(":", 1)
            source_slot = int(source_slot_text)
            target_slot = int(target_slot_text)
            source = by_id[source_id]
            target = by_id[target_id]
            output = source.get("outputs", [])[source_slot]
            input_data = target.get("inputs", [])[target_slot]
        except (KeyError, IndexError, TypeError, ValueError):
            errors.append(f"invalid endpoint: {value}")
            continue
        target_key = (target_id, target_slot)
        if target_key in claimed:
            errors.append(f"duplicate target input: {value}")
        claimed.add(target_key)
        if not types_compatible(output.get("type"), input_data.get("type")):
            errors.append(f"incompatible types: {value}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--reconstruction-report", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    reconstruction = json.loads(Path(args.reconstruction_report).read_text(encoding="utf-8"))
    by_path = {str(Path(result["path"]).resolve()).lower(): result for result in reconstruction["results"]}
    os.environ["FLOW_WRANGLER_MEMORY_MANIFEST"] = str(manifest_path)
    ai._blueprint_index.cache_clear()

    results = []
    for entry in manifest.get("unconnected", []):
        path = Path(entry["file"]).resolve()
        workflow = json.loads(path.read_text(encoding="utf-8-sig"))
        compact = compact_nodes(workflow)
        fingerprint = ai._blueprint_fingerprint(compact)
        index = ai._blueprint_index(tuple(str(item) for item in ai._memory_workflow_paths()))
        variants: dict[tuple[str, ...], str] = {}
        for _mtime, reference_path, _reference_workflow in index.get(fingerprint, []):
            blueprint = ai.lookup_local_blueprint({
                "nodes": compact,
                "workflow_hint": reference_path,
            })
            keys = tuple(sorted(edge_key(edge) for edge in blueprint.get("selected_edges", [])))
            variants.setdefault(keys, reference_path)

        run = by_path.get(str(path).lower(), {})
        actual = sorted(run.get("extra", []))
        safety_errors = structural_errors(workflow, actual)
        item = {
            "path": str(path),
            "nodes": len(workflow.get("nodes", [])),
            "actual_connections": len(actual),
            "structurally_safe": not safety_errors,
            "safety_errors": safety_errors,
            "reference_variants": len(variants),
        }
        if len(variants) == 1:
            expected, source = next(iter(variants.items()))
            item.update({
                "verdict": "exact-reference" if actual == list(expected) else "reference-mismatch",
                "reference": source,
                "expected_connections": len(expected),
                "missing": sorted(set(expected) - set(actual)),
                "extra": sorted(set(actual) - set(expected)),
            })
        elif len(variants) > 1:
            item["verdict"] = "ambiguous-reference"
        else:
            item["verdict"] = "safe-no-ground-truth" if not safety_errors else "unsafe-no-ground-truth"
        results.append(item)

    summary = {
        "workflows": len(results),
        "unambiguous_references": sum(item["reference_variants"] == 1 for item in results),
        "reference_exact": sum(item["verdict"] == "exact-reference" for item in results),
        "reference_mismatch": sum(item["verdict"] == "reference-mismatch" for item in results),
        "ambiguous_references": sum(item["verdict"] == "ambiguous-reference" for item in results),
        "no_ground_truth": sum(item["reference_variants"] == 0 for item in results),
        "structurally_safe": sum(item["structurally_safe"] for item in results),
        "structurally_unsafe": sum(not item["structurally_safe"] for item in results),
        "created_connections": sum(item["actual_connections"] for item in results),
    }
    report = {
        "passed": summary["reference_mismatch"] == 0 and summary["structurally_unsafe"] == 0,
        "summary": summary,
        "results": results,
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], **summary, "report": str(output)}, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
