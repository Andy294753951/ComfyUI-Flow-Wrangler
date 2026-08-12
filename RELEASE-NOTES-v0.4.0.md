# ComfyUI Flow Wrangler v0.4.0

`v0.4.0` adds an optional, fully local hybrid backend for Smart Connect while
keeping the deterministic browser solver as the default.

## Highlights

- **Exact local blueprint restore** reconnects a selected topology when it
  matches a saved local workflow. A workflow hint distinguishes saved revisions
  that have the same nodes but different wiring.
- **Local workflow contracts** reuse stable node and port relationships for
  related, non-identical graphs.
- **Optional Ollama fallback** asks a small loopback-only model to choose among
  safety-filtered candidate edges when local evidence is insufficient.
- **Confidence-based abstention** remains the default for ambiguous inputs; the
  solver can leave a socket unresolved instead of forcing a plausible mistake.

The recommended low-VRAM fallback is `qwen3:4b`. Ollama is optional and the
hybrid backend is disabled until it is explicitly enabled in ComfyUI settings.

## Reliability and compatibility

- Added Minimax H3, Ref2VA, Motion Context, RTX upscale, VHS, LoRA/MODEL-chain,
  control-image and legal IMAGE/AUDIO feedback-loop contracts.
- Added support for union socket types, empty port names, object-form positions,
  numeric/boolean identifiers, missing saved port types and dynamic link slots.
- Large graphs now retain candidates fairly across target inputs, capped at
  4,096 candidates and an 8 MB local request limit.
- Ollama output is restricted to candidate IDs supplied by the frontend and is
  rechecked by deterministic type, role, branch and cycle safety gates.
- No workflow execution node is added and no third-party Python dependency or
  install script is required.

## Validation

- Maintainer local corpus: **3,032/3,032 workflows exact**, with
  **43,354/43,354 valid edges** restored after disconnecting every graph.
- Deduplicated corpus: **1,204/1,204 topologies exact**, with
  **23,633/23,633 edges** restored.
- Native zero-link workflows with an unambiguous reference:
  **64/64 exact**. Another 158 files without ground truth passed endpoint, type
  and single-input structural checks; they are not claimed as semantically exact.
- Forced `qwen3:4b` fallback: three stability rounds totaling **195/195 exact**,
  followed by a post-large-graph-fix **65/65 exact** run.
- Python backend/release tests, JavaScript syntax, frontend AI contracts,
  Smart Connect roles, solver safety, example workflows and sink contracts pass.

## Privacy

- Saved workflow discovery and matching stay on the machine.
- Ollama requests are accepted only for a loopback endpoint (`127.0.0.1`,
  `localhost` or `::1`).
- No workflow, prompt or generated media is sent to a cloud service by Flow
  Wrangler.

## Upgrade

Pull the latest `main`, restart ComfyUI, then hard-refresh the browser with
`Ctrl+F5`. Enable **Flow Wrangler: Use local hybrid backend for Shift+W Smart
Connect** only if you want blueprint, contract and optional Ollama assistance.

Keep **Force Ollama fallback (testing only)** disabled during normal use.
