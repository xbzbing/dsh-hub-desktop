# 发布策略

## 当前策略：source-only

DSH Hub Desktop 当前不发布官方桌面二进制文件。GitHub Release 只包含：

- Git tag；
- Release Note；
- GitHub 自动生成的 `Source code (zip)` 和 `Source code (tar.gz)`。

Release 不得上传 `.app`、`.dmg`、`.zip`、`.exe`、`latest-*.yml` 或 `SHA256SUMS.txt` 等二进制、更新元数据和校验和资产。

原因是项目尚未具备 Apple Developer ID 签名与 Apple notarization 公证能力。未签名、未公证的 macOS 应用可能被 Gatekeeper、企业 MDM 或 EDR 拦截；本地打包成功不等价于可以安全公开分发。

## 本地构建

以下命令仍保留，供开发、本机验证和受控测试使用：

```bash
pnpm dist
pnpm dist:mac
pnpm dist:mac:zip
pnpm dist:win
```

所有命令带 `--publish never`。这些本地构建产物不是官方发布物，不应作为 GitHub Release 资产上传。

## 发布流程

发布前运行：

```bash
CI=true pnpm release:check -- --pre
```

演练通过后，人工执行：

```bash
git tag -a v<version> -m "DSH Hub <version>"
git push origin v<version>

gh release create v<version> --draft \
  --title "DSH Hub <version>" \
  --notes-file docs/releases/v<version>.md
```

确认 Draft Release 中只有发布说明和 GitHub 自动生成的源码归档后再发布。该命令不得添加任何 `dist/` 参数。

## 恢复官方二进制发布的门槛

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
