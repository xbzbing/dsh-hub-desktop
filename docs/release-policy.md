# 发布策略

## 当前策略

公开 Release 的分发模式由发布说明的「分发方式」小节显式声明，`scripts/release/lib.mjs` 的 `DISTRIBUTION_MODES` 校验：

- `source-only`：只有 Git tag、Release Note 和 GitHub 自动生成的 `Source code (zip)` / `Source code (tar.gz)`。
- `windows-unsigned`：在 `source-only` 基础上，附带构建的 **未签名** Windows NSIS 安装包（`DSH-Hub-Setup-<版本>.exe`）与其校验清单 `SHA256SUMS.txt`。

无论哪种模式，公开 Release **都不上传** macOS 二进制（`.app`、`.dmg`、`.zip`）、自动更新元数据（`latest-*.yml`）与差分中间产物（`.blockmap`）；`scripts/release/lib.mjs` 做形态白名单校验，发布说明声明越界资产会被 `pnpm test` 与 `pnpm release:check` 拒绝。

发布主路径是 GitHub Actions 的 `Release` workflow：在 Actions 页面手动触发并输入版本，workflow 校验该提交的 CI 已成功、跑门禁、在 `windows-latest` 上构建未签名安装包、生成 `SHA256SUMS.txt`，然后推 tag、建 Draft 并做资产白名单核验；Draft 通过后由人在 Release 页面点 Publish。workflow 不自动发布，也不上传白名单之外的资产（决策依据见 `docs/adr/0020-github-actions-release.md`）。本地 `pnpm release:publish` 保留为断网或 workflow 故障时的兜底路径。

关于未签名 Windows 安装包：产物未经代码签名，Windows 首次运行会触发 SmartScreen「未知发布者」提示（点「更多信息 → 仍要运行」可继续）。发布说明必须明示这一点并提供 `SHA256SUMS.txt` 供手工校验完整性。

macOS 二进制在完成签名与公证前仍不公开分发（见下方门槛）。

## 本地构建

以下命令供开发、本机验证、受控测试与兜底发布使用：

```bash
pnpm dist
pnpm dist:mac
pnpm dist:mac:zip
pnpm dist:win
pnpm dist:win:local   # mac 上交叉构建 Windows 包
```

所有命令带 `--publish never`。`pnpm dist:mac` 默认只生成未封装的 `.app` 目录；需要 zip 验证时使用 `pnpm dist:mac:zip`。macOS 产物不是官方发布物，不得作为 GitHub Release 资产。

发布 workflow 在 Windows runner 上直接执行 `pnpm dist:win`；`dist:win:local` 只用于无法使用 workflow 时在本机交叉构建。

## 发布流程

1. 把版本号与发布说明提交到 `main`，等待该提交的 CI 变绿。
2. 在 Actions 页面选择 **Release** → **Run workflow**，输入与 `package.json` 一致的版本号（如 `0.1.18`）。
3. workflow 依次：校验版本/说明/CI → lint、typecheck、单测 → `pnpm dist:win` → 生成校验清单 → 推 tag → 建 Draft → 资产白名单核验，停在 Draft。
4. 在 Release 页面确认 Draft 只含 `DSH-Hub-Setup-<版本>.exe` 与 `SHA256SUMS.txt`，点 **Publish release**（网页发布会自动迁移 Latest 徽标）。

兜底路径（断网或 workflow 不可用时）：

```bash
CI=true pnpm release:check -- --pre
pnpm dist:win:local
mkdir -p dist/upload && cp dist/DSH-Hub-Setup-<版本>.exe dist/upload/
node scripts/release/checksums.mjs dist/upload
pnpm release:publish                   # 幂等：停在 Draft 并完成资产白名单核验
pnpm release:publish -- --publish      # PATCH draft=false make_latest=true 并复核 Latest
```

或在网页点 **Publish release**（自动迁移 "Latest" 徽标）。手动走 API 时必须带 `make_latest="true"`，否则徽标会留在更早的版本上。逐步命令、人工兜底命令与失败恢复见 `docs/release-runbook.md`。

## 恢复 macOS 二进制发布的门槛

恢复 macOS 二进制资产进入公开 Release，必须经独立变更重新评估本策略，并满足以下全部条件：

1. 有效的 Apple Developer Program 成员资格。
2. Developer ID Application 证书及私钥仅安装在受控构建机或安全注入 CI Secret。
3. Apple notarization 凭据或 API key 仅存于系统钥匙串或 CI Secret，绝不进入仓库、日志或 Release Note。
4. 已完成 notarization 和 staple。
5. 已验证签名、公证和可执行性：

   ```bash
   codesign --verify --deep --strict --verbose=2 <App>.app
   spctl --assess --type execute --verbose=4 <App>.app
   xcrun stapler validate <App>.app
   ```

6. 已在干净 macOS 机器完成下载、安装与启动验证。
7. 已明确支持的架构，并对每种分发包完成测试。
8. 安装包、`latest-*.yml` 和校验和通过字节一致性验证。

满足条件后应同时恢复 mac 发布配置、签名/公证流水线、二进制 Release Note 契约和相关验证；在此之前不得预置 GitHub publish provider。

## Windows 代码签名（可选升级）

当前 Windows 安装包未签名，仅以 `SHA256SUMS.txt` 提供完整性校验。日后取得 OV/EV 代码签名证书后，可对安装包做 Authenticode 签名并通过 SmartScreen 验证，再将发布说明的 Windows 安装包替换为签名版本。
