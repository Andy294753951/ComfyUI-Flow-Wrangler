# ComfyUI Flow Wrangler

A workflow editing efficiency extension for ComfyUI.

Flow Wrangler reduces repetitive node editing operations by automatically inferring connection intent, organizing graph structure, and providing high-level workflow manipulation commands.

Inspired by Blender Node Wrangler, Flow Wrangler focuses on reducing mechanical operations in node-based workflows while keeping ComfyUI's original graph system unchanged.

Current version:

```
v0.2.7
```

---

# Features

## Smart Connect

Flow Wrangler automatically analyzes nodes and searches for the most suitable connections.

Supported data flows:

- Model
- CLIP
- Conditioning
- Latent
- VAE
- Image
- Video
- Multi-output pipelines
- Complex third-party nodes


Smart Connect considers:

1. Type compatibility
2. Input and output slot names
3. Node title semantics
4. Existing connections
5. Source reuse
6. Graph topology
7. Spatial information as a weak fallback


The design principle:

> Type decides what can connect.  
> Semantics decide what should connect.  
> Position only provides additional hints.

---

# Global Smart Connect

Select multiple nodes and press:

```
Shift + W
```

Flow Wrangler analyzes the selected graph and automatically connects available inputs.

Designed for:

- Large workflows
- Broken workflow recovery
- Rapid workflow construction
- Complex multi-branch pipelines

---

# Semantic Conditioning Matching

Flow Wrangler includes semantic matching for ambiguous CONDITIONING workflows.

When multiple nodes output:

```
CONDITIONING
```

Flow Wrangler can distinguish semantic intent from:

```
Positive Prompt
Negative Prompt

positive
negative

正向
负向
正面
负面
uncond
```

This improves matching for workflows containing:

- Multiple CLIP Text Encode nodes
- Multiple prompt branches
- ControlNet pipelines
- LoRA branches
- Regional conditioning

---

# Advanced Graph Operations

## Swap Input

Shortcut:

```
Shift + S
```

Swap the first compatible connected input of selected nodes.

---

## Output Reroute

Insert Reroute nodes into existing output connections while preserving original graph relationships.

Useful for:

- Cleaning large workflows
- Preparing graphs for editing
- Improving readability

---

## Data Flow Layout

Automatically arrange nodes according to real dependency relationships.

Unlike simple grid alignment, Flow Wrangler uses graph structure to determine node ordering.

---

## Batch Bypass

Quickly toggle bypass state for selected nodes.

---

# Large Workflow Testing

Flow Wrangler includes complex regression workflows designed to test Smart Connect behavior.

Testing scenarios include:

- Text → Image pipelines
- Image → Image pipelines
- Text → Video pipelines
- Image → Video pipelines
- Video workflows
- ControlNet workflows
- IPAdapter workflows
- Upscaling workflows
- Multi-model pipelines
- Mixed custom node environments


The test suite evaluates:

- Connection accuracy
- Semantic matching
- Ambiguous source selection
- Duplicate source avoidance
- Missing node tolerance
- Large graph performance

---

# Included Test Workflows

The examples directory contains unconnected workflows for Smart Connect testing.

Coverage includes:

```
ComfyUI Core
IPAdapter Plus
ControlNet
ControlNet Aux
UltimateSDUpscale
WanVideoWrapper
Multiple CLIP Text Encode
Multiple Conditioning branches
Image workflows
Video workflows
Multi-stage generation pipelines
```

Import a test workflow:

1. Select all nodes

```
Ctrl + A
```

2. Run:

```
Shift + W
```

to evaluate automatic connection behavior.

Some workflows require third-party custom node packages.

Missing nodes are intentionally useful for testing heterogeneous workflow handling.

---

# Keyboard Shortcuts

Flow Wrangler avoids conflicts with common ComfyUI and browser shortcuts.

Default shortcuts:

## Smart Connect Gesture

```
Alt + Right Click
```

Hold Alt and right click source and target nodes.

Flow Wrangler automatically selects the most suitable connection.

---

## Global Smart Connect

```
Shift + W
```

Automatically connect selected nodes.

---

## Swap Input

```
Shift + S
```

Swap compatible connected inputs.

---

All commands can be customized in:

```
Settings → Keybindings
```

Search:

```
Flow Wrangler
```

---

# Installation

Go to your ComfyUI custom nodes directory:

```bash
cd ComfyUI/custom_nodes
```

Clone:

```bash
git clone https://github.com/Andy294753951/ComfyUI-Flow-Wrangler.git
```

Restart ComfyUI.

Then refresh the browser:

```
Ctrl + F5
```

---

# Settings

Flow Wrangler settings are available inside ComfyUI.

Available options:

- Enable / disable Alt gesture
- Allow replacing existing inputs
- Configure Smart Connect behavior

---

# Compatibility

Flow Wrangler:

- Does not add Python nodes
- Does not modify inference behavior
- Does not require additional models
- Does not use GPU resources
- Works with custom nodes
- Uses official ComfyUI frontend extension APIs


Implemented using:

- Commands
- Keybindings
- Menu Commands
- Settings
- Locale system

---

# Localization

Default frontend UI strings are written in English.

Translations are provided through ComfyUI's official locale system.

Included:

```
locales/en
locales/zh
```

The project follows ComfyUI localization conventions for commands and settings.

---

# Design Philosophy

Flow Wrangler does not attempt to fully understand workflows like a human.

Instead, it combines multiple weak signals:

```
Type compatibility
        +
Semantic hints
        +
Graph structure
        +
Connection state
        +
Spatial information
```

to produce the most likely connection.

When the workflow does not contain enough information, Flow Wrangler avoids aggressive guessing.

---

# Known Limitations

Some workflows are inherently ambiguous.

Example:

```
CLIP Text Encode
CLIP Text Encode
CLIP Text Encode
```

with identical:

- Names
- Outputs
- Positions
- Semantics

The graph itself does not contain enough information to determine user intent.

In these cases Flow Wrangler performs conservative matching instead of assuming certainty.

---

# Version History

## v0.2.7

- Improved Smart Connect accuracy for large heterogeneous workflows.
- Improved same-type source selection.
- Improved semantic matching reliability.
- Added more complex regression testing scenarios.
- Improved handling of multi-branch generation pipelines.
- Verified behavior against large-scale synthetic workflows.

---

## v0.2.5

- Restored Positive / Negative CONDITIONING semantic matching.
- Improved distinct source selection for same-type inputs.
- Added runtime semantic matching tests.
- Maintained ComfyUI official locale support.

---

## v0.2.4

- Converted frontend default UI strings to English.
- Added official locale structure.
- Added localization regression checks.

---

## v0.2.3

- Added Positive / Negative Conditioning semantic matching.
- Improved multi-CONDITIONING source selection.
- Reduced duplicate source usage.
- Improved graph-based fallback behavior.

---

# License

MIT License
