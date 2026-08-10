# ComfyUI Flow Wrangler v0.3.0

`v0.3.0` 是 Flow Wrangler 的一次 Smart Connect 可靠性升级，重点从“尽量接满”转向“优先接对”。

## Highlights

- 新增 **Hard Constraint Gate**：明确错误的数据角色在软评分前直接排除。
- 新增 **Data Identity / Target Contract**：区分控制图、生成图、解码图、最终输出和 MODEL 变换阶段。
- 新增 **branch / namespace ownership**：多条相似分支同时存在时优先保持分支一致。
- 改进 **LoRA / MODEL transform chain**：多级 LoRA、Control Apply、LLLite 与通用 `MODEL -> MODEL` 节点可以稳定进入下游采样器。
- 增加 **conservative abstention**：高风险 IMAGE / MODEL 证据不足时宁可留空，不强行猜测。

## Fixed

- Pose / Depth / Canny 控制图误接最终 Save / Preview。
- 预处理器输入被错误 Hard Gate 阻止。
- 平行 IPAdapter / MODEL 变换分支被误串联。
- `LoraLoaderModelOnly` 输出被基础模型抢占 KSampler.model。
- SaveImage / PreviewImage 标题中出现 `Pose Control` 等流程描述时被误当成控制图 sink。
- Krea2 / Krea2 Control、Anima / Anima LLLite 等同族 namespace 的阶段串线。
- 可选 MASK 被无意自动连接。

## Validation

- Ground Truth Suite: **16/16 exact PASS**
- Boss Fight Suite: **5/5 exact PASS**
- 414-node Omniverse: **458/458 exact**
- Real Krea2 → Pose/Depth → Anima workflow: **32/32 exact**
- 7 additional Krea2 / Anima solver workflows: **all exact PASS**
- Geometry fuzz: **120/120 exact PASS**

## Compatibility

- Frontend-only extension.
- No additional Python nodes.
- No extra Python dependencies or install scripts.
- Default JavaScript UI strings remain English; English and Simplified Chinese locale files are included.

## Upgrade

Replace the existing `ComfyUI-Flow-Wrangler` folder with v0.3.0, restart ComfyUI, then force-refresh the browser (`Ctrl+F5`).

If a highly customized third-party workflow still contains multiple indistinguishable candidates, v0.3.0 may intentionally leave a high-risk input unresolved rather than guess.
