ComfyUI Flow Wrangler

一个面向 ComfyUI 节点工作流的前端效率扩展，重点减少重复拉线、精确点选、批量重连和大型工作流整理的机械操作。

Flow Wrangler 借鉴 Blender Node Wrangler 一类工具“减少机械操作”的交互目标，但不复制其代码、节点规则或实现方式。

当前正式版本：v0.3.0

主要功能

Alt + 右键智能连接：按住 Alt 右键点击源节点，再点击目标节点；也支持从源节点直接右键拖到目标节点。

全局智能连接：选择多个节点后按 Shift+W，为选区中的空闲输入寻找最合理的来源。

Positive / Negative 语义识别：多个 CONDITIONING 来源同时存在时，优先保持正负提示词语义一致。

分支 / 阶段感知：识别可观察到的 lane、scene、pair、target、namespace 等工作流身份，降低同类型节点跨分支串线。

Hard Constraint + Data Identity：在软评分之前排除明确错误的数据角色，并区分控制图、生成图、解码图、模型变换链等不同阶段。

LoRA / MODEL 变换链：支持 MODEL -> MODEL 的多级变换，包括 LoRA、Control Apply、LLLite 和第三方模型变换节点。

保守 abstention：高风险候选证据不足时宁可留空，也不强行猜测。

交换输入：选择节点后按 Shift+S，交换第一对类型兼容且已经连接的输入。

输出中继：为已有输出连线插入 Reroute，同时保持原目标关系不变。

数据流整理：按真实依赖关系对所选节点进行分层排列。

快速旁路：批量切换所选节点的 Bypass 状态。

命令菜单：在画布或节点右键菜单中打开 Flow Wrangler。

快捷键

Flow Wrangler 默认避开 ComfyUI、浏览器和常见系统快捷键冲突。

Shift+W：全局智能连接所选节点

Shift+S：交换输入

Alt + 右键：智能点选 / 拖动连接

全部命令都会注册到 设置 → 快捷键，搜索 Flow Wrangler 即可查看或重新绑定。

安装

进入 ComfyUI 的 custom_nodes 目录后运行：

git clone https://github.com/Andy294753951/ComfyUI-Flow-Wrangler.git

也可以下载仓库 ZIP，并解压为：

ComfyUI/custom_nodes/ComfyUI-Flow-Wrangler

然后重启 ComfyUI，并在浏览器中强制刷新页面（Ctrl+F5）。

Flow Wrangler 是纯前端扩展：不新增 Python 推理节点，不需要额外 Python 依赖，也不会增加模型或显存负担。

设置

在 ComfyUI 设置中搜索 Flow Wrangler：

可关闭 Alt + 右键点击 / 拖动 智能连接手势。

默认只连接空闲输入。

可允许 Smart Connect 替换已有输入。

Smart Connect v0.3.0

v0.3.0 的重点不是“尽可能把所有输入都接满”，而是提高正确连接的优先级。

当前连接决策大致分为：

类型兼容性：ComfyUI 实际注册的 input / output 类型首先必须兼容。

Hard Constraint Gate：明确违反数据角色、方向或阶段的候选会在评分前被排除。

Data Identity / Target Contract：区分原始图、控制图、生成 / 解码结果、终端输出、MODEL 变换等数据身份。

Branch / Namespace Ownership：多个相同类型分支同时存在时，优先维持同一 lane / scene / pair / namespace。

语义与插槽角色：Positive / Negative、reference、control、model、latent、vae 等输入角色参与评分。

空间位置：距离和相对方向仅作为较弱的辅助信号。

保守 abstention：高风险 IMAGE / MODEL 仍无法可靠区分时，可以保持未连接。

简单来说：

类型决定能不能接；角色、分支和数据阶段决定应该接谁；位置只负责辅助；证据不足时宁可不接。

v0.3.0 重点修复

修复 Pose / Depth / Canny 等预处理图误接最终 Save / Preview 的问题。

修复预处理器输入方向被 Hard Gate 错误阻止的问题。

修复多条平行 IPAdapter / MODEL 变换分支被错误串成一条链的问题。

修复 LoraLoader / LoraLoaderModelOnly 输出不优先进入下游采样器的问题。

支持多级 LoRA、Control Apply、Anima LLLite 和通用 MODEL -> MODEL 变换链。

修复 Krea2 / Krea2 Control、Anima / Anima LLLite 等同族 namespace 的阶段归属。

修复 SaveImage / PreviewImage 标题中出现 Pose Control 等流程描述时污染数据身份的问题。

可选 MASK 在没有明确 Mask / Inpaint 意图时保持未连接。

对高风险但低置信度的 IMAGE / MODEL 候选使用 abstention，减少“类型合法但语义错误”的无声串线。

完整历史请查看 CHANGELOG.md。

验证与回归测试

v0.3.0 发布前执行了仓库自带测试和复杂 Ground Truth 回归：

Repository regression tests：全部通过。

Ground Truth Suite：16 / 16 exact PASS，平均 F1 100%。

Boss Fight Suite：5 / 5 exact PASS，平均 F1 100%。

414 节点 Omniverse：458 / 458 exact。

Krea2 → Pose / Depth → Anima 真实工作流：32 / 32 exact。

7 套额外 Krea2 / Anima 复杂回归：全部 exact。

120 轮随机几何扰动：120 / 120 exact。

这些测试用于防止修复一个场景时重新破坏旧的 Conditioning、Control、LoRA、MODEL、LATENT 和多分支行为。

测试工作流

examples/ 中包含多套完全未接线的压力测试工作流，覆盖：

ComfyUI Core

IPAdapter Plus

ControlNet / ControlNet Aux

UltimateSDUpscale

WanVideoWrapper

多个 CLIP Text Encode / Conditioning 来源

Positive / Negative 分支

一对多输出

多种第三方自定义节点混合场景

导入后可 Ctrl+A 全选，再按 Shift+W 测试全局智能连接。

部分示例依赖第三方节点包；未安装对应节点时可能显示缺失节点，这也可用于测试异构节点包和缺失节点容错。

ComfyUI Manager / 多语言

为满足 ComfyUI Manager 审核要求：

web/flow_wrangler.js 的默认 UI 字符串保持英文。

命令、设置等通过 ComfyUI locale 机制提供英文和简体中文翻译。

扩展不包含额外 pip 依赖或安装脚本。

已知限制

Smart Connect 只能依据当前节点图中可观察到的信息推断意图。

如果多个候选节点的类型、名称、标题、分支身份和位置都无法区分，就不存在可靠信息可以唯一恢复用户真实意图。v0.3.0 对这类高风险情况优先选择留空，而不是假装确定答案。

对高度定制的第三方节点，如果它们使用非常泛化的输入 / 输出类型与命名，也可能需要用户手动补充少量连接。

使用建议

复杂工作流中，为关键节点使用清晰标题可以显著提高分支识别，例如：

Positive Prompt
Negative Prompt
Scene-01 Pose
Scene-01 Depth
Scene-02 Pose
FINAL-01
FINAL-02

这不是强制要求；它只是为存在多个完全同类型候选时提供额外可观察信息。

项目定位

Flow Wrangler 不是生成模型节点包，也不会改变模型推理结果。

它是 ComfyUI 的节点编辑效率工具，重点解决重复拉线、精确点选、多节点重连、数据流整理和大型工作流中的机械性编辑成本。

许可证

本项目采用 MIT License。
