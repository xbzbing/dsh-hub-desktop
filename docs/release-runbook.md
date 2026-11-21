# 发布 Runbook（windows-unsigned）

> 本文是发布的**操作口径**：策略与门槛见 [release-policy.md](./release-policy.md)，
> 机器校验见 `pnpm release:check`（离线演练）；发布主路径是 `.github/workflows/release.yml`，
> 本地 `pnpm release:publish` 为兜底。每次发布按本文逐步执行；流程变化须回写本文，不留口头版本。
> 最近一次完整走通（CI 路径）：v0.1.19（2026-11-22）；本地兜底路径：v0.1.17（2026-11-19）。

## 0. 前置

- 发布主路径：GitHub 仓库写权限（能触发 Actions、能点 Publish）；不需要本机代理。
- 兜底路径（本机执行）：Node 22+、pnpm；`git` 与 `gh` 可用（本机 `api.github.com` 需走代理时：`export HTTPS_PROXY=http://127.0.0.1:7897`，`gh` 不读系统 PAC）。
- 兜底上传资产走 `uploads.github.com`，与本机代理链路不兼容（大文件传一半即 HTTP 408 `Upload body timed out`）。发布时用 `NO_PROXY=uploads.github.com` 让上传直连、其余 API 仍走代理。
- 兜底构建机要求：
  - **Windows 包在 mac 上交叉构建**（`pnpm dist:win:local`）——electron-builder 自行下载 Windows 版 Electron（`-c.electronDist=` 置空），NSIS 用统一 bundle 的 **arm64 原生 makensis**（`electron-builder.yml` 的 `toolsets.nsis: "1.2.1"`；legacy 3.0.4.1 的 mac 端 makensis 只有 x86_64，未装 Rosetta 的 Apple Silicon 上 spawn EBADCPU 失败）。
  - 构建需访问 GitHub Releases 下载 NSIS bundle 与 win-codesign 工具链：网络受限时 `ELECTRON_GET_USE_PROXY=true HTTPS_PROXY=… pnpm dist:win:local`。
- 本地有推送 origin 的权限；发布说明已评审。

## 1. 门禁与演练

主路径由 Release workflow 自带门禁：`pnpm lint`、`pnpm typecheck`、`pnpm test`，并在开头用 `scripts/release/ci-guard.mjs` 确认**该提交的 CI 已成功**。因此触发前只需保证：版本提交已推送，且它的 CI 已变绿。

兜底路径在本地先跑：

```bash
CI=true pnpm typecheck && CI=true pnpm lint && CI=true pnpm test
DSH_HUB_E2E_HIDDEN=1 CI=true pnpm test:e2e   # 本机边工作边跑；Linux CI 无需 HIDDEN
CI=true pnpm release:check -- --pre
```

演练全绿（PASS/SKIP，无 FAIL）才继续；SKIP 的「HEAD 处于 tag」属预期（发布时才打标签）。

## 2. 版本与发布说明

1. `package.json` 的 `version` 改为目标版本（纯 semver，无 `SNAPSHOT`）。
2. 新增 `docs/releases/v<version>.md`，沿用上一版结构：
   - 一级标题 `# DSH Hub v<version>`、「- 发布日期: YYYY-MM-DD」、「## 分发方式」必须是 `- \`windows-unsigned\``、「## 产物」声明 `DSH-Hub-Setup-<version>.exe` 与 `SHA256SUMS.txt`；
   - 占位符（TODO/待填等）会被 `pnpm test` 拒绝。
3. 提交：`chore: 版本升至 <version> 并添加发布说明`。
4. 再跑一次 `CI=true pnpm test`（发布说明格式由 `tests/upgrade/release-metadata.test.ts` 校验），推送并等该提交的 CI 变绿。

## 3. 构建与校验

### 3.1 主路径（Release workflow）

在 Actions 页面触发后，workflow 在 `windows-latest` 上执行 `pnpm dist:win`，把安装包复制到 `dist/upload/`，再用 `node scripts/release/checksums.mjs dist/upload` 生成清单并交给发布脚本校验。构建日志里可核对 `[release] sha256 <digest>  DSH-Hub-Setup-<version>.exe`。
v0.1.19 在 `windows-latest` 原生构建：exe 120,748,034 字节，SHA-256 `103ac5bd…b9178`；v0.1.18 为 120,748,160 字节。GitHub 资产的 `digest` 与 `SHA256SUMS.txt` 一致可作上传后的交叉校验。

### 3.2 兜底路径（本机交叉构建）

```bash
pnpm dist:win:local                                  # Windows 版 Electron + NSIS bundle 需联网
mkdir -p dist/upload && cp dist/DSH-Hub-Setup-<version>.exe dist/upload/
node scripts/release/checksums.mjs dist/upload       # 生成 dist/upload/SHA256SUMS.txt
shasum -a 256 dist/DSH-Hub-Setup-<version>.exe       # 与 SHA256SUMS.txt 第一列比对
```

产物量级参考（本机交叉构建）：v0.1.17 的 exe 为 120,651,536 字节，比 v0.1.16（120,631,547 字节）多 19,989 字节（三处修复带来的载荷变化，仍在同一档位）；v0.1.16 的 exe 为 120,631,547 字节，比 v0.1.15（120,723,157 字节）少 91,610 字节（Electron 45.3.3→45.3.4 与随包 npm 12.2.3 带来的载荷变化，仍在同一档位）；v0.1.15 的 exe 为 120,723,157 字节，比 v0.1.14（120,629,264 字节）多 93,893 字节（Electron 45.2.3→45.3.3 带来 Chromium 载荷变化，属正常档位）；v0.1.14 比 v0.1.13（120,625,095 字节）多 4,169 字节；v0.1.13 比 v0.1.12（120,624,208 字节）多 887 字节；v0.1.12 比 v0.1.11（120,623,576 字节）多 632 字节；v0.1.11 比 v0.1.10（120,597,490 字节）多 26 KB；v0.1.10 比 v0.1.9（120,595,763 字节）多 1.7 KB，v0.1.9 又比 v0.1.8（120,593,361 字节）多 2.4 KB；这一档差异来自载荷变化。相对更早版本多出的约 9 MB 来自 electron-builder 26.18 的 NSIS 归档压缩率（同一载荷手工 7z -mx=9 为 96 MB）；`compression` 选项不影响该归档，出现更大偏离时先比载荷再比压缩。workflow 在 Windows runner 上原生构建，字节数与本机交叉构建不同，以当次 Release 资产为准。

## 4. 发布

### 4.1 主路径（Release workflow）

Actions → **Release** → **Run workflow**，输入目标版本（与 `package.json` 一致）。workflow 会：

1. 校验版本输入、`package.json`、发布说明三者一致，且发布说明符合 `windows-unsigned` 契约；
2. 确认该提交的 CI 已成功（未跑完或失败直接拒绝）；
3. 跑 lint / typecheck / test；
4. 在 Windows runner 上构建并生成 `dist/upload/`；
5. 调用 `scripts/release/publish.mjs`：推 annotated tag → 建/更新 Draft → 上传 `exe` 与 `SHA256SUMS.txt` → 白名单精确核验，停在 Draft。

日志末尾出现 `6/6 停在 Draft（默认）` 即成功；失败按 §6 处理后重跑（各步幂等）。

### 4.2 兜底路径（本机）

```bash
pnpm release:publish                   # 幂等，可中断重跑
pnpm release:publish -- --dry-run      # 预演：远端查询照常，变更动作只打印不执行
```

脚本（`scripts/release/publish.mjs`）按序执行并逐步打印日志：

1. 发布说明校验：与 `package.json` 版本一致、可解析、无占位符；
2. 本地资产校验：`windows-unsigned` 要求 `dist/upload/` 的安装包与 `SHA256SUMS.txt` 齐全，且实测 sha256 与清单一致；`source-only` 无资产；
3. 前置确认：当前在 main、工作树干净、本地 main 与 origin/main 同步；
4. 推 tag：本地缺失则建于 HEAD；远端缺失则推送，已存在必须与本地一致；
5. 建 Draft 或更新已有 Draft（说明与资产幂等覆盖；已发布的 Release 直接拒绝）；
6. 远端资产白名单核验：与「分发方式」声明的集合**精确一致**（多传少传都拒绝）。

标签必须打在 main 的发布提交上（Source code 归档才有源码语义）——由第 3 步保证。

脚本不可用时的等价人工命令（兜底）：

```bash
git tag -a v<version> -m "DSH Hub <version>"
git push origin v<version>
gh release create v<version> --draft \
  --title "DSH Hub <version>" \
  --notes-file docs/releases/v<version>.md \
  dist/upload/DSH-Hub-Setup-<version>.exe dist/upload/SHA256SUMS.txt
```

## 5. 核验 Draft 并发布

核验 Draft 资产（workflow 第 6 步已核验；网页上再目视确认一次）：

```bash
gh api "repos/xbzbing/dsh-hub-desktop/releases?per_page=5" \
  --jq '.[] | select(.tag_name=="v<version>") | {draft, assets: [.assets[].name]}'
```

禁止出现：mac 产物（`.dmg`/`.zip`/`.app`）、`latest-*.yml`、`.blockmap`（见 release-policy 资产白名单）。

确认无误后发布，二选一：

```bash
pnpm release:publish -- --publish   # PATCH draft=false make_latest=true，脚本复核 Latest 指向本 tag
```

或优先用网页上的 **Publish release** 按钮（自动迁移 "Latest" 徽标）。若手动走 API，必须带 `make_latest`：

```bash
gh api -X PATCH "repos/xbzbing/dsh-hub-desktop/releases/<id>" -F draft=false -F make_latest=true
```

核验：

```bash
gh release list --limit 4          # 新版本应带 Latest
gh release view v<version> --json assets,url
```

## 6. 幂等与失败恢复

| 断点 | 处理 |
| --- | --- |
| workflow 在门禁或 CI 校验失败 | 看日志修代码/等 CI 变绿后重新 Run workflow；不会产生 tag 或 Draft |
| workflow 在构建失败 | 直接重新 Run workflow；runner 每次从零构建，不依赖本机缓存 |
| tag 已存在（同版本重发） | 作废 tag：`git tag -d v<version> && git push origin :refs/tags/v<version>`，回到 §4（**破坏性**，确认无人引用后才做） |
| Draft 已存在、资产传错 | 重跑 workflow 或 `pnpm release:publish` 幂等覆盖（`--clobber`）；多余资产 `gh release delete-asset` |
| 已 Publish 后发现致命问题 | 不要删 Release 重发同版本号；发 patch 版本 |
| 本地兜底上传报 HTTP 408 | `uploads.github.com` 走了代理；加 `NO_PROXY=uploads.github.com` 重跑。失败残留的 `starter` 状态资产会让重传卡住，先 `gh api -X DELETE repos/xbzbing/dsh-hub-desktop/releases/assets/<id>` 删掉再重跑 |
| 兜底 npm 工具链下载失败（NSIS/win-codesign） | `ELECTRON_GET_USE_PROXY=true HTTPS_PROXY=…` 重跑；已缓存的部分在 `~/Library/Caches/electron-builder/` |

## 7. 发布后

- 在 Release 页人工点开 exe 与 `SHA256SUMS.txt` 各下载一次，确认可下载、大小一致。
- 若本版含行为变更，确认 README / 关键文档无过期表述。
- 本 runbook 与实际执行出现偏差时：以实际为准并回写本文（同一 PR）。
