# ComfyUI Flow Wrangler

一个针对 ComfyUI 节点工作流重新设计的效率扩展。

Flow Wrangler 的目标是减少节点编辑过程中反复拖线、精确点选、整理布局和重复操作的成本。它借鉴了 Blender Node Wrangler 一类工具“减少机械操作”的交互思路，但不复制其代码、节点规则或实现方式。

当前正式版本：`v0.2.3`

## 当前功能

- **Alt + 右键智能连接**  
  按住 `Alt` 右键点击源节点，再右键点击目标节点；也可以从源节点直接右键拖到目标节点。  
  Flow Wrangler 会根据插槽类型、名称、占用状态和节点关系自动选择合适的连接。

- **全局智能连接**  
  选择多个节点后按 `Shift+W`，为选区中的空闲输入寻找最合适的来源。  
  支持模型、CLIP、Conditioning、Latent、VAE、图像等常见数据流，以及一对多输出。

- **正负提示词语义识别**  
  当多个节点同时输出 `CONDITIONING` 时，Smart Connect 会进一步参考目标插槽名称和节点标题中的语义信息。  
  例如带有 `positive`、`negative`、`正向`、`负向`、`负面` 等关键词的节点，会优先匹配对应的 Conditioning 输入。

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
