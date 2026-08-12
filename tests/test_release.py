import importlib.util
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.4.0"
COMMAND_IDS = {
    "flow-wrangler.smart-connect",
    "flow-wrangler.swap-inputs",
    "flow-wrangler.add-reroutes",
    "flow-wrangler.arrange",
    "flow-wrangler.toggle-bypass",
    "flow-wrangler.show-menu",
}
SETTING_IDS = {
    "Comfy.FlowWrangler.LazyConnectGesture",
    "Comfy.FlowWrangler.ReplaceConnectedInputs",
    "Comfy.FlowWrangler.AIEnabled",
    "Comfy.FlowWrangler.AIModel",
    "Comfy.FlowWrangler.AIForceOllama",
}


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


class ReleaseMetadataTests(unittest.TestCase):
    def test_versions_are_synchronized(self):
        init_spec = importlib.util.spec_from_file_location("flow_wrangler", ROOT / "__init__.py")
        module = importlib.util.module_from_spec(init_spec)
        init_spec.loader.exec_module(module)
        self.assertEqual(module.__version__, VERSION)

        javascript = (ROOT / "web" / "flow_wrangler.js").read_text(encoding="utf-8")
        self.assertIn(f'const EXTENSION_VERSION = "{VERSION}";', javascript)
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn(f"version-v{VERSION}", readme)
        self.assertIn(f"Current version: `v{VERSION}`", readme)
        self.assertIn(f"当前版本：`v{VERSION}`", readme)
        self.assertNotIn("Current development version", readme)
        self.assertTrue((ROOT / f"RELEASE-NOTES-v{VERSION}.md").is_file())
        self.assertTrue((ROOT / f"VALIDATION-v{VERSION}.txt").is_file())

    def test_default_javascript_ui_contains_no_cjk_strings(self):
        javascript = (ROOT / "web" / "flow_wrangler.js").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"[\u3400-\u9fff]", javascript))

    def test_v023_smart_connect_features_are_present(self):
        javascript = (ROOT / "web" / "flow_wrangler.js").read_text(encoding="utf-8")
        for symbol in (
            "polarityFromText",
            "sourcePolarity",
            "inputPolarity",
            "conditioningPolarityScore",
            "titleAffinityScore",
            "inputRoleScore",
            "rootResourceScore",
            "const unused = candidates.filter",
            "structuralIdentityScore",
            "const strongDownstream = pool.filter",
            "identityContext",
        ):
            self.assertIn(symbol, javascript)

    def test_locale_files_cover_all_commands_and_settings(self):
        expected_commands = {command_id.replace(".", "_") for command_id in COMMAND_IDS}
        expected_settings = {setting_id.replace(".", "_") for setting_id in SETTING_IDS}

        for locale in ("en", "zh"):
            commands = load_json(ROOT / "locales" / locale / "commands.json")
            settings = load_json(ROOT / "locales" / locale / "settings.json")
            self.assertEqual(set(commands), expected_commands)
            self.assertEqual(set(settings), expected_settings)
            self.assertTrue(all(entry.get("label") for entry in commands.values()))
            self.assertTrue(all(entry.get("name") for entry in settings.values()))


if __name__ == "__main__":
    unittest.main()
