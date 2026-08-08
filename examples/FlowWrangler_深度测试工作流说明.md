# Flow Wrangler 深度测试工作流

这些工作流取自本机已有的真实工作流记录；已经清空所有 `links`、输入 `link` 和输出 `links`，不会自动执行任何流程。

其中第 03 套使用 WanVideoWrapper 节点。如果你的当前 ComfyUI 启动日志没有加载这个包，导入时会显示缺失节点；这正好可以用来测试 Flow Wrangler 对“缺失节点/异构节点包”的前端容错。第 01、02 套只使用图像工作流中已注册的节点。

## 文件

- `01_图像多分支_IPAdapter_ControlNet_未接线.json`
  - 来自高配单图工作流。
  - 覆盖 Comfy Core、IPAdapter Plus、ControlNet Aux、UltimateSDUpscale。
  - 约 23 个节点、3 个复杂分组。

- `02_连续漫画_UltimateUpscale_ControlNet_未接线.json`
  - 覆盖双参考图、提示词、ControlNet、高清修复和保存分支。
  - 约 22 个节点、5 个分组。

- `03_Wan视频_WanVideoWrapper_未接线.json`
  - 覆盖 WanVideoWrapper 的模型、T5、采样、TeaCache、VAE、BlockSwap 等节点。
  - 约 22 个节点、原视频工作流分组。

- `04_混合节点包压力矩阵_未接线.json`
  - 将以上三套真实工作流合成一个大画布。
  - 约 67 个节点、6 个空间测试组，适合测试大量节点、多分支和跨包匹配。

## 建议测试顺序

1. 在 ComfyUI 中打开一个文件。
2. `Ctrl+A` 选择全部节点。
3. 按 `Shift+W` 执行 Flow Wrangler 全局智能连接。
4. 观察提示词正/负分支、模型链、Latent、VAE 和输出节点是否匹配。
5. 对部分节点单独选择后测试 `Shift+S`、`Ctrl+Shift+W` 和 `Alt+右键拖动`。
6. 如需重做已有连接，在 Flow Wrangler 设置中开启“智能连接可替换已有输入”。

注意：未接线工作流的目标是测试“全局匹配”，不是直接运行出图/视频。建议每套先保存一个副本，再执行连接。

所有工作流都保存在当前输出目录，可通过 ComfyUI 的“打开工作流”导入。
