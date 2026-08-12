import os
import asyncio
import json
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import flow_wrangler_ai as ai


def sample_payload():
    return {
        "model": "qwen3:4b",
        "nodes": [
            {
                "id": "1",
                "type": "LoadImage",
                "title": "Source",
                "position": [0, 0],
                "inputs": [],
                "outputs": [{"index": 0, "name": "IMAGE", "type": "IMAGE"}],
            },
            {
                "id": "2",
                "type": "PreviewImage",
                "title": "Target",
                "position": [400, 0],
                "inputs": [{"index": 0, "name": "images", "type": "IMAGE"}],
                "outputs": [],
            },
        ],
        "candidates": [
            {
                "id": "C0001",
                "source_id": "1",
                "source_slot": 0,
                "source_label": "IMAGE",
                "source_type": "IMAGE",
                "target_id": "2",
                "target_slot": 0,
                "target_key": "2:0",
                "target_label": "images",
                "target_type": "IMAGE",
                "score": 1200,
                "evidence": 3,
                "geometry": [120, 0],
            }
        ],
    }


class LocalAIBackendTests(unittest.TestCase):
    def test_payload_validation_and_result_allowlist(self):
        nodes, candidates, model = ai._validate_payload(sample_payload())
        self.assertEqual(model, "qwen3:4b")
        self.assertEqual(len(nodes), 2)
        result = ai._validate_result(
            {"selected": {"bad": "UNKNOWN", "2:0": "C0001"}},
            candidates,
        )
        self.assertEqual([entry["candidate_id"] for entry in result["selected"]], ["C0001"])
        self.assertEqual(result["unresolved"], [])

    def test_remote_ollama_endpoint_is_rejected(self):
        with patch.dict(os.environ, {"FLOW_WRANGLER_OLLAMA_URL": "https://example.com"}):
            with self.assertRaises(ai.FlowWranglerAIError):
                ai._ollama_url()

    def test_candidate_chunks_keep_target_nodes_atomic(self):
        payload = sample_payload()
        payload["nodes"].extend(
            {"id": str(index), "type": "Node", "title": "x" * 160}
            for index in range(3, 42)
        )
        payload["candidates"] = []
        for target in range(2, 42):
            for option in range(12):
                payload["candidates"].append({
                    "id": f"C{target:03d}{option:02d}",
                    "source_id": "1",
                    "source_slot": 0,
                    "source_label": "IMAGE",
                    "source_type": "IMAGE",
                    "target_id": str(target),
                    "target_slot": 0,
                    "target_key": f"{target}:0",
                    "target_label": "image_" + "x" * 100,
                    "target_type": "IMAGE",
                })
        nodes, candidates, _model = ai._validate_payload(payload)
        chunks = ai._candidate_chunks(nodes, candidates)
        self.assertGreater(len(chunks), 1)
        target_chunk = {}
        for chunk_index, chunk in enumerate(chunks):
            for candidate in chunk:
                previous = target_chunk.setdefault(candidate["target_id"], chunk_index)
                self.assertEqual(previous, chunk_index)

    def test_schema_is_compact_target_mapping(self):
        schema = ai._response_schema()
        self.assertEqual(
            schema["properties"]["selected"]["additionalProperties"],
            {"type": "string"},
        )

    def test_memory_and_high_margin_contracts_are_combined_without_ollama(self):
        payload = sample_payload()
        payload["nodes"].extend([
            {
                "id": "3",
                "type": "TextGenerator",
                "title": "Generated path",
                "position": [0, 300],
                "inputs": [],
                "outputs": [{"index": 0, "name": "text", "type": "STRING"}],
            },
            {
                "id": "4",
                "type": "SaveText",
                "title": "Save path",
                "position": [400, 300],
                "inputs": [{"index": 0, "name": "path", "type": "STRING"}],
                "outputs": [],
            },
        ])
        payload["candidates"].extend([
            {
                "id": "C0002",
                "source_id": "3",
                "source_slot": 0,
                "source_label": "text",
                "source_type": "STRING",
                "source_node": "Generated path",
                "source_node_type": "TextGenerator",
                "target_id": "4",
                "target_slot": 0,
                "target_key": "4:0",
                "target_label": "path",
                "target_type": "STRING",
                "target_node": "Save path",
                "target_node_type": "SaveText",
                "score": 5000,
            },
            {
                "id": "C0003",
                "source_id": "1",
                "source_slot": 0,
                "source_label": "IMAGE",
                "source_type": "IMAGE",
                "source_node": "Source",
                "source_node_type": "LoadImage",
                "target_id": "4",
                "target_slot": 0,
                "target_key": "4:0",
                "target_label": "path",
                "target_type": "STRING",
                "target_node": "Save path",
                "target_node_type": "SaveText",
                "score": 0,
            },
        ])
        payload["candidates"][0].update({
            "source_node": "Source",
            "source_node_type": "LoadImage",
            "target_node": "Target",
            "target_node_type": "PreviewImage",
        })

        memory_workflow = {
            "nodes": [
                {
                    "id": 11,
                    "type": "LoadImage",
                    "title": "Source",
                    "pos": [0, 0],
                    "inputs": [],
                    "outputs": [{"name": "IMAGE", "type": "IMAGE"}],
                },
                {
                    "id": 12,
                    "type": "PreviewImage",
                    "title": "Target",
                    "pos": [400, 0],
                    "inputs": [{"name": "images", "type": "IMAGE"}],
                    "outputs": [],
                },
            ],
            "links": [[1, 11, 0, 12, 0, "IMAGE"]],
        }
        with tempfile.TemporaryDirectory() as directory:
            workflow_path = os.path.join(directory, "known.json")
            with open(workflow_path, "w", encoding="utf-8") as handle:
                json.dump(memory_workflow, handle)
            with patch.dict(os.environ, {"FLOW_WRANGLER_MEMORY_FILES": workflow_path}):
                result = asyncio.run(ai.solve_with_ollama(payload))

        self.assertEqual(result["model"], "local-workflow-memory+contracts")
        self.assertEqual(
            {entry["candidate_id"] for entry in result["selected"]},
            {"C0001", "C0002"},
        )
        self.assertEqual(result["unresolved"], [])

    def test_high_margin_contract_can_resolve_without_memory_or_ollama(self):
        payload = sample_payload()
        payload["candidates"][0].update({
            "source_node": "Source",
            "source_node_type": "LoadImage",
            "target_node": "Target",
            "target_node_type": "PreviewImage",
            "score": 5000,
        })
        with patch.object(ai, "_memory_selections", return_value=[]), patch.object(
            ai,
            "_solve_chunk",
            new=AsyncMock(side_effect=AssertionError("contract must avoid Ollama")),
        ):
            result = asyncio.run(ai.solve_with_ollama(payload, session=object()))

        self.assertEqual(result["model"], "local-contracts")
        self.assertEqual([item["candidate_id"] for item in result["selected"]], ["C0001"])

    def test_force_ollama_bypasses_workflow_memory(self):
        payload = sample_payload()
        payload["force_ollama"] = True
        ollama_result = {
            "selected": [
                {
                    "candidate_id": "C0001",
                    "target_key": "2:0",
                    "confidence": 0.91,
                    "reason": "test",
                }
            ],
            "unresolved": [],
        }
        with patch.object(
            ai,
            "_memory_selections",
            side_effect=AssertionError("forced Ollama must not read workflow memory"),
        ), patch.object(
            ai,
            "_solve_chunk",
            new=AsyncMock(return_value=ollama_result),
        ) as solve_chunk:
            result = asyncio.run(ai.solve_with_ollama(payload, session=object()))

        self.assertEqual(result["model"], "qwen3:4b")
        self.assertEqual(result["chunks"], 1)
        self.assertEqual(result["selected"], ollama_result["selected"])
        solve_chunk.assert_awaited_once()

    def test_local_blueprint_restores_an_exact_saved_workflow(self):
        workflow = {
            "nodes": [
                {
                    "id": 1,
                    "type": "LoadImage",
                    "title": "Source",
                    "pos": [0, 0],
                    "inputs": [],
                    "outputs": [
                        {"name": "IMAGE", "type": "IMAGE", "links": [17]}
                    ],
                },
                {
                    "id": 2,
                    "type": "PreviewImage",
                    "title": "Target",
                    "pos": [400, 0],
                    "inputs": [
                        {"name": "images", "type": "IMAGE", "link": 17}
                    ],
                    "outputs": [],
                },
            ],
            "links": [[17, 1, 0, 2, 0, "IMAGE"]],
        }
        request = {
            "nodes": [
                {
                    "id": "1",
                    "type": "LoadImage",
                    "title": "Source",
                    "position": [0, 0],
                    "inputs": [],
                    "outputs": [{"name": "IMAGE", "type": "IMAGE"}],
                },
                {
                    "id": "2",
                    "type": "PreviewImage",
                    "title": "Target",
                    "position": [400, 0],
                    "inputs": [{"name": "images", "type": "IMAGE"}],
                    "outputs": [],
                },
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            workflow_path = os.path.join(directory, "known.json")
            with open(workflow_path, "w", encoding="utf-8") as handle:
                json.dump(workflow, handle)
            with patch.dict(os.environ, {
                "FLOW_WRANGLER_MEMORY_FILES": workflow_path,
                "FLOW_WRANGLER_AUTO_MEMORY": "0",
                "FLOW_WRANGLER_MEMORY_MANIFEST": "",
            }):
                ai._blueprint_index.cache_clear()
                result = ai.lookup_local_blueprint(request)

        self.assertTrue(result["matched"])
        self.assertEqual(result["model"], "local-workflow-blueprint")
        self.assertEqual(result["selected_edges"], [{
            "source_id": "1",
            "source_slot": 0,
            "target_id": "2",
            "target_slot": 0,
        }])

    def test_current_workflow_topology_is_not_used_as_its_own_memory(self):
        workflow = {
            "nodes": [
                {
                    "id": 1,
                    "type": "LoadImage",
                    "title": "Source",
                    "pos": [0, 0],
                    "inputs": [],
                    "outputs": [{"name": "IMAGE", "type": "IMAGE"}],
                },
                {
                    "id": 2,
                    "type": "PreviewImage",
                    "title": "Target",
                    "pos": [400, 0],
                    "inputs": [{"name": "images", "type": "IMAGE"}],
                    "outputs": [],
                },
            ],
            "links": [[1, 1, 0, 2, 0, "IMAGE"]],
        }
        with tempfile.TemporaryDirectory() as directory:
            workflow_path = os.path.join(directory, "same-graph.json")
            with open(workflow_path, "w", encoding="utf-8") as handle:
                json.dump(workflow, handle)
            fingerprint = ai._workflow_fingerprint(workflow["nodes"])
            memory = ai._build_workflow_memory(
                [ai.Path(workflow_path)], True, fingerprint,
            )
        self.assertEqual(memory, {})


if __name__ == "__main__":
    unittest.main()
