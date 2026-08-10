# Changelog

## v0.3.0 - 2026-08-10

- 正式引入保守 Hard Constraint / Target Contract 层，在软评分前阻止明确错误边。
- 增加 IMAGE / MODEL 数据身份与阶段判断，区分控制图、生成 / 解码结果、终端输出和模型变换链。
- 修复 Pose / Depth / Canny 预处理输入方向及控制图消费者的方向性问题。
- 修复控制图误接最终 SaveImage / PreviewImage 的问题，同时保留显式“保存控制图”场景。
- 修复 Save / Preview 标题中的 `Pose Control` 等流程描述污染控制图语义的问题。
- 修复多条平行 IPAdapter / MODEL 分支被误识别为串联链的问题。
- `LoraLoader`、`LoraLoaderModelOnly` 与通用 `MODEL -> MODEL` 节点统一进入模型变换链，支持多级 LoRA / Control Apply / LLLite 后再进入采样器。
- 增加 branch / namespace 归一化，兼容 `Krea2` / `Krea2 Control`、`Anima` / `Anima LLLite` 等同族阶段。
- 可选 MASK 在没有明确 Mask / Inpaint 意图时保持未连接。
- 对高风险且证据不足的 IMAGE / MODEL 候选增加保守 abstention：宁可留空，不猜测。
- 修复真实运行时 `_nodes` 存在时，终端 Save / Preview 被错误判作控制分支消费导致的状态性串线。
- Ground Truth Suite `16/16` exact PASS；Boss Fight Suite `5/5` exact PASS。
- 414 节点 Omniverse `458/458` exact；Krea2→Pose/Depth→Anima 真实工作流 `32/32` exact。
- 新增 7 套 Krea2 / Anima solver 复杂回归及 120 轮几何扰动测试，全部 exact PASS。

## v0.2.8 - 2026-08-10

- 增加基于节点 archetype 的方向性先验，区分 Loader、Sampler、Decode、Preprocess、Upscale、Adapter、Control、Sink 等角色。
- 修正 LATENT → VAEDecode、IMAGE → Upscale、ControlNet image、IPAdapter image 等高频同类型误连。
- 对 SaveImage / PreviewImage 等终端节点的透传输出增加保护，减少 Preview → Preview / Save → Save 伪链。
- 保留 v0.2.7 的结构化身份、分支、Positive / Negative Conditioning 和阶段保护逻辑。
- 增加面向真实示例工作流的回归验证。

## v0.2.7 - 2026-08-10

- 增加结构化工作流身份匹配：识别 lane、scene / pair、target、pack / decoy 等标题关系，降低大规模同类型候选中的串线。
- 增加重复资源池识别：多个 Video Model / Motion Model / Checkpoint 变体同时存在时，可根据显式编号与目标编号进行稳定匹配。
- 增加 A / B Motion Model 的交替分支先验，并保持显式语义优先。
- 对 Refiner 阶段加入跨阶段保护，避免同 lane 的 Base Checkpoint 抢走 Refiner 资源。
- 对明显标记为 Decoy 的来源增加保守惩罚，避免干扰节点抢占真实目标。
- Boss Fight Ground Truth v1：`5/5` Exact PASS，平均 F1 `100%`。

## v0.2.6 - 2026-08-10

- Smart Connect 增加通用的分支 / 阶段语义亲和度。
- 增加 `reference / target`、Vision、Control、VAE Encode、Inpaint、Refiner、IPAdapter、Upscale、Aggregate 等输入角色匹配。
- 当存在上游兼容候选时，优先排除位于目标右侧的下游候选，减少结果节点反向接回前级节点。
- 对模型、CLIP、VAE、Video Model、Motion Model、ControlNet、CLIP Vision、IPAdapter、Upscale Model、Audio 等根资源增加上游来源先验。
- 保留 Positive / Negative CONDITIONING 语义、同目标来源去重和弱 Y 轴兜底。

## v0.2.5 - 2026-08-10

- 恢复 Positive / Negative CONDITIONING 语义匹配逻辑。
- 恢复同类型输入优先使用不同兼容来源、语义不足时以垂直位置弱辅助的逻辑。
- 保留英文默认 UI 和官方英中 locale 支持。

## v0.2.4 - 2026-08-10

- 按 ComfyUI Manager 审核要求，将 Toast、右键菜单、命令面板和设置面板的默认 UI 字符串统一为英文。
- 通过 ComfyUI 官方 locale 机制为命令和设置保留简体中文翻译。
- 增加 UI 字符串与 locale 文件的静态回归检查。

## v0.2.2 - 2026-08-08

- 移除会触发 Chrome / Edge “关闭窗口”的 `Ctrl+Shift+W` 默认绑定；命令仍可在设置 → 快捷键中自行绑定。
- 增强 `Alt + 右键` 连接：支持先点源节点、再点目标节点，同时保留直接右键拖动。
- 使用当前 ComfyUI 完整快捷键注册表复核默认绑定。

## v0.2.1 - 2026-08-08

- 新增面向整组选区的全局智能连接，可处理分支和一对多输出。
- 新增 Alt + 右键懒连接、交换输入、输出中继、数据流整理和批量旁路。
- 接入新版 ComfyUI Commands、Keybindings、Menu Commands 和 Settings 扩展接口。
- 将全局智能连接快捷键调整为 `Shift+W`。
- 新增 4 套完全未接线的跨节点包压力测试工作流。
