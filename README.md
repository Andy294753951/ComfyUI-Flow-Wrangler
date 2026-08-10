# ComfyUI Flow Wrangler

一个针对 ComfyUI 节点工作流重新设计的效率扩展。

Flow Wrangler 的目标是减少节点编辑过程中反复拖线、精确点选、整理布局和重复操作的成本。它借鉴了 Blender Node Wrangler 一类工具“减少机械操作”的交互思路，但不复制其代码、节点规则或实现方式。

当前正式版本：`v0.2.5`

## 当前功能

- **Alt + 右键智能连接**  
  按住 `Alt` 右键点击源节点，再右键点击目标节点；也可以从源节点直接右键拖到目标节点。  
  Flow Wrangler 会根据插槽类型、名称、占用状态和节点关系自动选择合适的连接。

- **全局智能连接**  
  选择多个节点后按 `Shift+W`，为选区中的空闲输入寻找最合适的来源。  
  支持模型、CLIP、Conditioning、Latent、VAE、图像等常见数据流，以及一对多输出。

- **正负提示词语义识别**  
  当多个节点同时输出 `CONDITIONING` 时，Smart Connect 会进一步参考目标插槽名称和节点标题中的语义信息。  
  例如带有 `positive`、`negative`、`正向`、`正面`、`负向`、`负面` 等关键词的节点，会优先匹配对应的 Conditioning 输入。

- **同类型来源去重**  
  当多个兼容来源同时存在时，会尽量避免同一个输出重复占用多个同类型输入，让不同 Conditioning、Image 或其他来源获得更合理的匹配机会。

- **交换输入**  
  选择节点后按 `Shift+S`，交换第一对类型兼容且已经连接的输入。

- **输出中继**  
  为所选节点已有的输出连线插入 Reroute，同时保持原有目标关系不变。

- **数据流整理**  
  按照所选节点之间的真实数据依赖关系进行分层排列。

- **快速旁路**  
  批量切换所选节点的 Bypass 状态。

- **命令菜单**  
  在画布或节点右键菜单中选择 **Flow Wrangler** 即可访问相关功能。

## 快捷键说明

Flow Wrangler 默认避开了一些 ComfyUI 和浏览器常用快捷键：

- `Alt+C`：新版 ComfyUI 自带“折叠 / 展开所选节点”
- `Ctrl+Alt+C`：经常被系统截图工具占用
- `Ctrl+Shift+W`：Chrome / Edge 默认用于关闭窗口

Flow Wrangler 的全部命令都会注册到：

**设置 → 快捷键**

搜索 `Flow Wrangler` 即可查看或自行修改绑定。

## 安装

进入 ComfyUI 的 `custom_nodes` 目录后运行：

```bash
git clone https://github.com/Andy294753951/ComfyUI-Flow-Wrangler.git
```

也可以下载仓库 ZIP，并解压为：

```text
ComfyUI/custom_nodes/ComfyUI-Flow-Wrangler
```

然后：

1. 重启 ComfyUI
2. 在浏览器中强制刷新页面（`Ctrl+F5`）

## 设置

在 ComfyUI 设置中搜索 `Flow Wrangler`：

- 可关闭 `Alt + 右键点击 / 拖动` 智能连接手势。
- 默认只连接空闲输入。
- 可允许 Smart Connect 替换已有输入。

## Smart Connect 匹配逻辑

Flow Wrangler 的智能连接并不是单纯寻找“最近的同类型插槽”。

当前匹配会综合考虑：

1. **类型兼容性**
2. **插槽名称**
3. **节点标题中的语义信息**
4. **同一来源是否已经被使用**
5. **节点之间的方向与距离**

对于 Positive / Negative Conditioning 这类存在二义性的连接，语义信息的优先级会高于单纯的节点位置。

例如当多个节点同时输出 `CONDITIONING` 时，带有以下语义关键词的节点会优先匹配对应输入：

- `positive`
- `negative`
- `正向`
- `正面`
- `负向`
- `负面`
- `负提示`
- `uncond`

当没有足够语义信息时，节点在画布上的相对位置只作为较弱的辅助判断。

简单来说：

> **类型决定能不能接，语义决定更应该接谁，位置只负责辅助判断。**

插件默认 UI 使用英文，并通过 ComfyUI 官方 locale 机制为命令和设置提供简体中文翻译。

## 兼容性设计

- 纯前端扩展，不增加额外 Python 节点。
- 不增加模型、显存或推理负担。
- 根据 ComfyUI 当前实际注册的插槽类型和名称进行匹配。
- 可与已安装的第三方自定义节点共同工作。
- 使用新版 ComfyUI 前端的 Commands、Keybindings、Menu Commands 和 Settings 扩展接口。
- 修改操作接入图变更边界，可进入 ComfyUI 的撤销历史。
- Smart Connect 会优先保持已有工作流结构，不强行连接明显缺少兼容来源的输入。

## 测试工作流

`examples/` 中包含多套未接线测试工作流，用于验证 Smart Connect 在复杂节点图中的行为。

覆盖场景包括：

- ComfyUI Core
- IPAdapter Plus
- ControlNet / ControlNet Aux
- UltimateSDUpscale
- WanVideoWrapper
- 多个 CLIP Text Encode
- 多个 Conditioning 来源
- Positive / Negative Conditioning 分支
- 一对多输出
- 多种第三方自定义节点混合工作流

导入测试工作流后，可按：

```text
Ctrl+A
```

全选节点，然后按：

```text
Shift+W
```

测试全局智能连接。

部分测试工作流依赖第三方节点包。如果对应节点包未安装，可能显示缺失节点；这也可以用于测试异构节点包和缺失节点情况下的容错行为。

## v0.2.5 更新

- 完整保留 v0.2.3 的 Positive / Negative CONDITIONING 语义匹配。
- 同一目标存在多个同类型输入时，优先使用不同的兼容来源。
- 继续保留 v0.2.4 的英文默认 UI 与英文、简体中文 locale。

## v0.2.4 更新

- 按 ComfyUI Manager 审核要求，将前端默认 UI 字符串统一为英文。
- 使用 ComfyUI 官方 locale 文件提供英文和简体中文命令、设置名称。
- 增加版本、默认 UI 字符串和 locale 覆盖范围的回归检查。

## v0.2.3 更新

### Smart Connect

- 改进多个 `CONDITIONING` 来源同时存在时的匹配逻辑。
- 新增 Positive / Negative Conditioning 语义判断。
- 支持从节点标题中识别 `positive`、`negative`、`正向`、`正面`、`负向`、`负面` 等提示。
- 减少同一个 Conditioning 来源重复占用多个同类型输入的情况。
- 当存在多个兼容来源时，优先让不同来源匹配不同输入。
- 节点 Y 轴位置改为弱辅助条件，而不是主要判断依据。

### 兼容性

- 保持原有 `Alt + 右键` 智能连接行为。
- 保持 `Shift+W` 全局智能连接。
- 保持交换输入、Reroute、布局、Bypass 等已有功能。
- 不增加额外 Python 依赖。
- 仍然保持纯前端扩展结构。

## 已知限制

Smart Connect 只能根据当前工作流中能够观察到的信息推断连接意图。

例如存在多个 CLIP Text Encode 节点，并且它们：

- 输出类型完全相同；
- 节点名称完全相同；
- 没有正负语义标记；
- 没有明显的上下或前后位置关系；

那么插件无法绝对确定用户真正希望哪一个连接到 Positive 或 Negative。

这种情况下，Flow Wrangler 会根据类型、占用状态和空间关系进行保守推断，而不会假设自己能够理解不存在的信息。

对于高度定制的第三方节点，如果多个输入和输出使用完全相同的类型与命名，也可能存在无法仅凭节点图信息消除的二义性。

## 使用建议

为了让 Smart Connect 在复杂工作流中获得更准确的结果，可以适当为关键节点使用带有语义的信息命名，例如：

```text
Positive Prompt
Negative Prompt
正向提示词
负向提示词
角色 Conditioning
风格 Conditioning
```

这不是强制要求，但在多个同类型来源同时存在时可以提供额外的匹配信息。

## 项目定位

Flow Wrangler 并不是一个新的生成模型节点包。

它更接近一个 ComfyUI 节点编辑效率工具，重点解决：

- 重复拉线
- 精确点选插槽
- 多节点重新连接
- 数据流整理
- 常用节点操作
- 大型工作流中的机械性编辑成本

它不会改变模型本身的推理结果，也不会增加额外的模型计算负担。

## 许可证

本项目采用 [MIT License](LICENSE)。
