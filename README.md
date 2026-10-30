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

### 前置条件（一次性）
1. ~~在 Marketplace 注册 publisher 并把 `package.json` 的 `publisher` 改为该 ID~~ —— 已完成：`publisher` 已设为 `baozilaji`。
2. **仍需在网页端完成**：在 [VS Code Marketplace 管理页](https://marketplace.visualstudio.com/manage) 的 `baozilaji` publisher 设置里，把本仓库（`baozilaji/vscode-coco-animation`）添加为 **Trusted Publisher（受信任的发布者）**。这一步是 `vsce publish --oidc` 免 PAT 发版的前提，不做则发版会鉴权失败。

### 方式 A：自动发版（推荐，免 PAT）
本仓库已内置 GitHub Actions 工作流（`.github/workflows/publish.yml`），基于 GitHub OIDC + Marketplace Trusted Publishing，无需任何令牌：

```bash
# 1) 升版本号（编辑 package.json 的 version，遵循语义化版本）
# 2) 提交并打标签（标签必须与 package.json 版本一致）
git add -A && git commit -m "release: v0.1.2"
git tag v0.1.2
git push --tags          # 推送标签即触发自动编译 + 测试 + 发布
```

工作流内置两道护栏：publisher 不能是 `local`；Git 标签版本须与 `package.json` 一致，否则直接失败。

### 方式 B：本地手动发布
```bash
npx vsce package --allow-missing-repository   # 生成 .vsix
npx vsce publish --oidc                        # 免 PAT 发布（需已完成上面的前置条件）
# 或把生成的 .vsix 在 Marketplace 网页手动上传
```

> 注意：Azure DevOps 全局 PAT 已于 2026-12-01 退役，推荐用上面的 `--oidc` 或手动上传 VSIX 方式发布。

## 许可证

见 [LICENSE](./LICENSE)。
