# 0020. 发布主路径迁到 GitHub Actions（Windows runner，Draft 停点）

- 状态：已采纳
- 日期：2026-11-19
- 取代关系：取代 [0008](./0008-semi-automated-publish.md) 决策 2「不负责构建」与决策 3「不是流水线」，以及 [0004](./0004-release-windows-unsigned.md) 中「无自动发布流水线」的表述；0004 的分发模式、资产白名单与 `--publish never` 约束全部继续有效

## 背景

v0.1.17 及之前，Windows 安装包由 macOS 交叉构建（`pnpm dist:win:local`）：NSIS 工具链、Windows 版 Electron 与随包 npm/pnpm 都在本机下载缓存，构建结果受本机代理、缓存与网络状态影响；发布则按 runbook 人工敲命令，上传 120MB 资产也走本机链路。

v0.1.17 发布后，一次与代码无关的既有 E2E 竞态让主分支 CI 偶发转红——产物本身没有问题，但暴露出发布流程缺少一条机器约束：**发布必须建立在 CI 已通过的提交上**。同时，构建环境与发布操作都应在可复现、可审计的地方完成。

## 决策

1. 新增 `.github/workflows/release.yml`，只用 `workflow_dispatch` 触发（输入目标版本），不监听 push 或 tag。
2. 在 `windows-latest` 上用 `pnpm dist:win` 构建未签名 NSIS 安装包，并用 `scripts/release/checksums.mjs` 生成 `SHA256SUMS.txt`；不再依赖 macOS 交叉构建。
3. 发布前置由 `scripts/release/ci-guard.mjs` 机器校验：输入版本、`package.json`、`docs/releases/v<版本>.md` 三者一致；发布说明符合 `windows-unsigned` 契约；该提交的 CI workflow 已成功（`gh run list`）。任一不满足即拒绝发布。
4. 复用 `scripts/release/publish.mjs` 完成推 annotated tag、建/更新 Draft、上传 `exe` 与 `SHA256SUMS.txt`、资产白名单精确核验；workflow 不传 `--publish`，**停在 Draft**。
5. 由人在 Release 页面点 **Publish**（或在本地执行 `pnpm release:publish -- --publish`），保留「机器核验 + 人眼确认」双闸。
6. 权限最小化：`contents: write` 与 `actions: read`，只用 `GITHUB_TOKEN`，不新增 secret；`electron-builder.yml` 仍不配置 publish provider。
7. 本地 `pnpm release:publish` 保留为断网或 workflow 故障时的兜底路径，与 workflow 共用同一脚本和纯函数，不维护第二套资产判定。

## 被否决的备选

- **维持纯本地构建发布**：构建依赖本机代理、NSIS bundle 与 Electron 缓存，环境不可复现；上传大资产也受本机网络影响。
- **push tag 自动触发**：tag 一旦推送就构建发布，可能发布尚未过 CI 的提交；tag 与「核验后再发」的语义耦合过紧。
- **workflow 直接发布并置 Latest**：未签名安装包缺少人工核对资产的环节，误发代价高；改用 Environment 审批会引入额外配置面与权限模型。
- **引入第三方 release action**：增加供应链面与版本维护成本；`gh` 已随 runner 提供，现有脚本可直接复用。

## 后果

- 发布入口变为 Actions 页面的 Release workflow；runbook 以 workflow 为主路径、本地脚本为兜底。
- 构建环境从 macOS 交叉构建换成 Windows 原生构建，产物字节数会不同（校验清单仍自洽）；runbook 的量级参考按新构建重新记录。
- 发布前置依赖主分支 CI：CI 未完成或失败时 workflow 直接拒绝，需先修复再触发。
- workflow 必须先在默认分支上存在，`workflow_dispatch` 才会在 Actions 页面列出；历史 tag 与已发布 Release 不受影响。
