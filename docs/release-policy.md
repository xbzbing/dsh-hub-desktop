# 发布策略

## 当前策略

公开 Release 支持两种分发模式，由发布说明的「分发方式」小节显式声明：

- `source-only`：只有 Git tag、Release Note 和 GitHub 自动生成的 `Source code (zip)` / `Source code (tar.gz)`。
- `windows-unsigned`：在 `source-only` 基础上，额外提供**未签名**的 64 位 Windows 安装包与 SHA-256 校验和。

两种模式都**不得**上传 `.app`、`.dmg`、`.zip`、`latest-*.yml` 等 macOS 二进制与自动更新元数据：项目尚未具备 Apple Developer ID 签名与 Apple notarization 公证能力，未签名、未公证的 macOS 应用可能被 Gatekeeper、企业 MDM 或 EDR 拦截，本地打包成功不等价于可以安全公开分发。

`windows-unsigned` 的资产白名单只有两项：`DSH-Hub-Setup-<version>.exe` 与 `SHA256SUMS.txt`。安装包名刻意不含空格 —— GitHub 上传资产时会把空格归一化成点号，会让发布说明、校验和清单与实际下载到的文件名三者不一致。新增任何资产都必须先修改 `scripts/release/lib.mjs` 的白名单与本节说明，并由 `pnpm test` 与 `pnpm release:check` 把关。

### 未签名 Windows 安装包的已知影响

- 首次运行触发 SmartScreen「未知发布者」提示，需选择「更多信息 → 仍要运行」；对普通用户可用，但会降低信任度。
- 企业环境的 EDR / MDM 策略可能直接拦截。
- 自动更新不可用：未签名安装包不附带 `latest.yml`，客户端不检查更新。

消除这些影响需要 OV/EV 代码签名证书（EV 才能消除 SmartScreen 提示）。在具备证书前，`windows-unsigned` 是明示风险后的有意选择，而不是默认放行。

## 本地构建

以下命令仍保留，供开发、本机验证和受控测试使用：

```bash
pnpm dist
pnpm dist:mac
pnpm dist:mac:zip
pnpm dist:win
```

所有命令带 `--publish never`。`pnpm dist:mac` 默认只生成未封装的 `.app` 目录；需要 zip 验证时使用 `pnpm dist:mac:zip`。这些本地构建产物不是官方发布物：`windows-unsigned` 模式下的 Windows 安装包由标签流水线重新构建后上传，本地 macOS 产物不得作为 GitHub Release 资产。

## 发布流程

发布前运行：

```bash
CI=true pnpm release:check -- --pre
```

演练通过后，人工打标签并推送：

```bash
git tag -a v<version> -m "DSH Hub <version>"
git push origin v<version>
```

- `source-only`：按演练输出的命令创建 Draft Release。

  ```bash
  gh release create v<version> --draft \
    --title "DSH Hub <version>" \
    --notes-file docs/releases/v<version>.md
  ```

- `windows-unsigned`：推送标签即触发 `.github/workflows/release.yml`，在 `windows-latest` 上构建 NSIS 安装包、生成 `SHA256SUMS.txt`，创建 Draft Release 并上传资产。流水线只创建 Draft，不自动发布。

最后确认 Draft Release 的资产与校验和（`source-only` 只应有发布说明与自动生成的源码归档），再点击 Publish release。任何命令都不得添加 `dist/` 参数。

发布时优先使用网页上的 Publish 按钮：它会自动把 "Latest" 徽标移到新版本。若改用 API（`PATCH draft=false`）发布，GitHub **不会**自动迁移 Latest 徽标，必须同时带上 `make_latest="true"`，否则徽标会留在更早的版本上。

## 恢复 macOS 二进制发布的门槛

只有满足全部条件后，才可通过独立变更引入 `signed-binary` 分发模式：

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

满足条件后应同时恢复发布配置、签名/公证流水线、二进制 Release Note 契约和相关验证；在此之前不得预置 GitHub publish provider。
