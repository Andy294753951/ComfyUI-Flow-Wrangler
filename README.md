# ComfyUI Flow Wrangler

一个针对 ComfyUI 数据流重新设计的节点效率扩展。它借鉴的是“减少精确点选和重复操作”的交互目标，不复制 Blender Node Wrangler 的代码或节点规则。

## 当前功能

- **懒连接**：按住 `Alt`，从源节点向目标节点右键拖动；根据类型、插槽名称和占用状态选择连接。
- **全局智能连接**：选择多个节点后按 `Shift+W`，为每个空闲输入在整组选区中寻找最合适的来源；支持模型、正负提示词、Latent、VAE 等分支和一对多输出。
- **交换输入**：选择节点后按 `Shift+S`，交换第一对类型兼容的已连接输入。
- **输出中继**：为所选节点已有的输出连线插入 Reroute，保持原目标不变。
- **数据流整理**：按照所选节点之间的真实连线分层排列。
- **快速旁路**：批量切换所选节点的 Bypass 状态。
- **命令菜单**：`Ctrl+Shift+W`，或在画布/节点右键菜单选择 **Flow Wrangler**。

`Alt+C` 是新版 ComfyUI 自带的“折叠/展开所选节点”；`Ctrl+Alt+C` 也经常被系统截图工具占用。Flow Wrangler 不再使用这两个组合。快捷键可以在 ComfyUI 的快捷键设置中重新绑定。

## 安装

进入 ComfyUI 的 `custom_nodes` 目录后运行：

```bash
git clone https://github.com/Andy294753951/ComfyUI-Flow-Wrangler.git
```

也可以下载仓库 ZIP，解压为：

```text
ComfyUI/custom_nodes/ComfyUI-Flow-Wrangler
```

重启 ComfyUI，然后在浏览器中强制刷新页面（`Ctrl+F5`）。

## 设置

在 ComfyUI 设置中搜索 `Flow Wrangler`：

- 可关闭 `Alt + 右键拖动` 手势。
- 默认只连接空闲输入；可允许智能连接替换已有输入。

## 兼容性设计

- 纯前端扩展，不增加 Python 节点，不占用模型或显存。
- 使用 ComfyUI 当前注册的实际插槽类型、插槽名称、画布方向和距离进行全局匹配，兼容已安装的自定义节点。
- 使用新版前端的 Commands、Keybindings、Menu Commands 和 Settings 扩展接口。
- 修改操作接入图变更边界，可进入 ComfyUI 的撤销历史。

## 测试工作流

`examples/` 中包含 4 套完全未接线的压力测试工作流，覆盖 Comfy Core、IPAdapter Plus、ControlNet Aux、UltimateSDUpscale 和 WanVideoWrapper 等节点类型。

导入后可按 `Ctrl+A` 全选，再按 `Shift+W` 测试全局智能连接。WanVideoWrapper 未加载时，第 03、04 套可能显示缺失节点，可用于测试异构节点包和缺失节点容错。
