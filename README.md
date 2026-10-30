# CocoStudio 动画预览器

在 VS Code 中可视化预览 **CocoStudio / DragonBones 风格骨骼动画** 的「三件套」：

- `*.ExportJson`（骨架 + 动画数据）
- `*.plist`（TexturePacker `format:0` 图集坐标）
- `*.png`（图集图片）

右键任意 `.ExportJson` 即可打开预览面板，无需离开编辑器。

> 适用于颤抖吧星球、CocoStudio 等美术管线导出的 CocoStudio 1.x / DragonBones 2.x 资源。

## 功能特性

- **黑底画布实时预览**：按骨骼 `bz` 顺序 CPU 合成绘制，支持旋转/缩放。
- **动作下拉切换**：自动识别 `animation_data[0].mov_data[]` 中的多条 movement；
  当某动画含多个**互斥角色**（如 `dig1`~`dig6` 各为完整角色）时，单动作播放会
  自动 `computeExclude` 排除其它动作驱动的骨骼，避免「多脸叠加 / 散架」问题。
- **循环播放**：控件区「循环」勾选框（默认开启），播完自动回到首帧；取消则停在末帧
  （仍尊重动画自身 `loop` 字段）。
- **骨骼可见性**：右侧列表可逐层隐藏/显示，被互斥排除的骨标灰「其它动作」。
- **图集查看**：红框标注每个切片的图集坐标。
- **动作总览**：多角色变体一次性同屏对比缩略图，点击即切换。
- **播放控制**：帧滑块、FPS（1–60）、缩放滑杆（20%–400%）。

## 安装

### 方式一：从 VSIX 安装（开发 / 内部分发）

1. 在项目根目录执行 `npx vsce package --allow-missing-repository`，生成 `coco-animation-viewer-<ver>.vsix`；
2. 双击该 `.vsix`，或在 VS Code 中 `code --install-extension coco-animation-viewer-<ver>.vsix`。

### 方式二：从 VS Code Marketplace 安装

在扩展商店搜索 **CocoStudio 动画预览器** 并安装（发布后可用）。

## 使用

1. 在资源管理器中**右键任意 `*.ExportJson`** → 选择 `CocoStudio 动画: 预览 ExportJson`；
2. 或在命令面板（`Cmd/Ctrl+Shift+P`）中搜索 `CocoStudio` 触发该命令。

## 支持的动画结构说明

- 坐标体系为 Y 轴向上；关键帧 `x/y` 是相对 bind 的增量；`dI < 0` 表示本帧隐藏该骨。
- 当 `mov_data` 含多条互斥动作时，默认选取「骨骼数 × 时长」最饱满的一条作为初始动作，
  避免选到粒子已飞散的空帧。

## 开发与构建

```bash
npm install
npm run compile      # 编译 src/extension.ts -> out/extension.js
# 按 F5 打开「扩展开发宿主」进行调试
```

## 测试

逻辑层用真实资源做断言（无需浏览器）。测试资源目录通过环境变量注入，避免把本地
绝对路径写进工程：

```bash
COCO_TEST_RES=/你的资源目录/ani_chao_yue node test/verify.js
```

## 打包与发布

```bash
npx vsce package --allow-missing-repository   # 生成 vsix
npx vsce publish                             # 发布到 Marketplace（需先注册 publisher）
```

> 注意：Azure DevOps 全局 PAT 已于 2026-12-01 退役，推荐使用 GitHub Actions
> `vsce publish --oidc` 或手动上传 VSIX 的方式发布。

## 许可证

见 [LICENSE](./LICENSE)。
