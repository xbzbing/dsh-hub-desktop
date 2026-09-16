# AGENTS.md — DSH Hub Desktop

> 仓库级规则文件（agent 上下文基线，始终加载）。只承载**项目架构与稳定准则**；
> 进度与任务状态见 `docs/开发任务清单.md`。

## 项目是什么

个人使用的 Electron 桌面工具：统一管理多个 dsh（DeepSeek Harness）实例 —— 本地 spawn、
SSH 隧道、远程 HTTP 直连；认证走 dsh-auth-gateway 协议（密码 + TOTP + HttpOnly Cookie 注入）。

- 需求基线：`docs/PRD.md`；架构：`docs/dsh-hub-desktop-design.md`；实现计划：`docs/desktop-implementation-plan.md`
- UI 视觉基线：`design/dsh-hub-desktop.html`（视图以 `data-od-id` 对应）；token 真理源：`design/brand-spec.md`（OKLch，明暗双主题）

## 技术栈（已评审定版）

- Electron 43 + electron-vite 5 + Vite 7 + React 18 + TypeScript 5.9（strict + `noUncheckedIndexedAccess`）
- Vitest 4（单测）· Playwright `_electron`（E2E）· ESLint 9 flat + Prettier 3 · pnpm 11 · Node 22
- zod 4.6.5（契约校验；唯一新增运行时依赖）
- **刻意避开**：vite 8 / TS 7 / React 19（版本线评审结论，勿升级）

## 架构地图

```
src/
├─ shared/          框架无关核心（node + web 双工程共享）
│  ├─ endpoint.ts   URL 解析/归一化（协议优先判定、host:port 消歧、IPv6、回环检测）
│  ├─ contracts.ts  实例模型（zod 判别联合）+ IPC 通道常量 + IpcResult 信封 + 版本迁移
│  ├─ settings.ts   非敏感偏好（语言/主题/托盘/自启/通知）
│  ├─ i18n/         扁平 key → {zh,en} 文案目录
│  └─ bridge.ts     preload 桥接面类型 + app 通道常量
├─ main/            主进程（唯一处理 electron 全局件的地方）
│  ├─ index.ts      窗口 / app://hub 协议 + CSP / 装配
│  ├─ ipc/register.ts  全部 ipcMain.handle 单点注册；入参 zod 边界校验 → 错误信封
│  ├─ registry/     实例注册表：原子写 + 滚动备份 + 损坏自愈 + 版本迁移（不 import electron）
│  ├─ transport/    local spawn / ssh 隧道 / http 直连
│  ├─ auth/         网关客户端 + 认证状态机 + 会话恢复
│  ├─ webview/      分区 Cookie 注入、请求拦截、视图计划
│  ├─ vault/        凭据保险库（显式勾选才落盘，默认不记住）
│  ├─ audit/        审计日志（白名单投影，绝不落凭据）
│  └─ shell/        托盘 / 原生设置 / 通知 的可注入实现
├─ preload/         contextBridge 白名单，只暴露 dshHub.*（类型与 shared 一致）
└─ renderer/        React 壳 + 视图（按 data-od-id 落地）· zustand store · i18n 护栏
tests/e2e/          Playwright _electron（壳链路 / 注册表 / 向导 / 详情）
tests/upgrade/      升级路径与发布元数据护栏
scripts/release/    发布演练与校验和
```

数据落盘：`<userData>/registry/instances.json`（userData 可由 `DSH_HUB_DATA_DIR` 覆盖）；
`hub-data/` 为运行时数据（已 gitignore）。

## 全局准则

1. **设计稿为准**：UI 以 `design/dsh-hub-desktop.html` 对应视图为基线；偏差必须记录理由。
2. **框架无关核心**：`src/shared`、registry、transport、auth、vault、audit **不 import electron**，
   保持可迁移；主进程装配层（`main/index.ts`、`main/tray.ts` 等）例外。
3. **零新增运行时依赖**：引入新依赖需在评审时说明理由，默认拒绝。
4. **质量门**：`pnpm typecheck && pnpm lint && pnpm test` 全绿才提交；E2E 至少跑一次。
   提交信息：`feat|fix|chore|test|docs: 描述`。
5. **契约测试是安全网**：涉及 auth 协议的任何改动必须过 `pnpm test:contract`（对真实网关）。

## 关键约定与模式

- **IPC 信封**：所有通道返回 `{ok:true,value} | {ok:false,code,message}`；错误码稳定
  （`invalid-input|not-found|invalid-state|io-error|internal`），渲染层按码表映射文案。
- **新增 IPC 通道的固定步骤**：① `contracts.ts` 加通道常量 + 类型；② `register.ts` 注册
  （入参经对应 zod schema）；③ `bridge.ts` + preload 白名单同步；④ 补测试。
  **安全要求**：新通道不得接受任意路径/命令等可被渲染层滥用为原语的参数
  （例如「打开数据目录」用空元组 schema，目录由主进程自行解析）。
- **实例模型**：`transport: local|ssh|http` 判别联合 × `authMode: auto|none|gateway`
  （auto 默认，连接时探测）；`transport` 不可经 patch 变更（改形态 = 删除重建）；
  跨变体补丁字段显式拒绝。
- **凭据纪律（硬规则）**：注册表 / 审计 / 日志 / 文档**绝不落**密码、OTP、Cookie、私钥；
  密码与 OTP 只经 IPC 参数瞬时传递并驻留内存；SSH 密钥只引用路径、不读取内容。
  审计记录由**显式白名单投影**构造（禁止对象展开）。
- **SSH 主机密钥**：TOFU —— 先 `ssh-keyscan` 预取指纹 → UI 确认 → 才放行；
  **指纹变更一律拒绝连接**（不自动清理），恢复只能由用户显式遗忘该主机指纹。
- **目录别名** `@shared → src/shared`，已在 electron.vite.config.ts / tsconfig ×3 /
  vitest.config.ts / playwright 侧配置。

## 常用命令

```bash
pnpm dev            # dev server + electron 窗口
pnpm typecheck      # node + web + e2e 三工程（tsconfig ×3）
pnpm lint           # eslint（flat config）
pnpm test           # 单测（vitest）
pnpm build          # 三端产物（E2E 前置）
pnpm test:e2e       # Playwright _electron
```

发布相关（详见 `docs/T14-发布演练.md`）：

```bash
pnpm dist:mac:zip      # mac zip + 更新元数据 dist/latest-mac.yml
pnpm dist:mac          # 含 dmg target（需网络可下 dmg 附加依赖）
pnpm dist:win          # NSIS + latest.yml（需 Windows/wine）
pnpm release:checksums # 生成 dist/SHA256SUMS.txt
pnpm release:check     # 发布演练：离线可校验部分，任一不符即非零退出
```

`dist`/`dist:*` 脚本**一律带 `--publish never`**（结构上不可能误发布），并由单测钉住。

## 环境注意事项（本机，含沙箱）

- `$HOME/pnpm-workspace.yaml` 会把所有子目录项目误判为工作区 → **本仓库已自建
  `pnpm-workspace.yaml` 阻断**，勿删。
- 沙箱限制写 `~/Library`：`pnpm install/add` 需追加
  `--store-dir=/tmp/pnpm-store --cache-dir=/tmp/pnpm-cache`；`npm view` 用 `--cache /tmp/npm-probe-cache`。
- Electron 二进制缓存 `ELECTRON_CACHE=/tmp/electron-cache`；若 `node_modules/electron/dist`
  缺失（pnpm 偶发跳过 postinstall，表现为 `Error: Electron uninstall`），执行：
  `ELECTRON_CACHE=/tmp/electron-cache node node_modules/electron/install.js`。
- 受限环境跑 E2E：`DSH_HUB_E2E_ARGS="--no-sandbox --disable-gpu" pnpm test:e2e`；
  E2E 数据自动隔离到 `hub-data/e2e*`，不污染真实 userData。
- npm 装 dsh 运行时走内网 registry 极慢时，设
  `DSH_HUB_NPM_REGISTRY=https://registry.npmmirror.com`（实测 15s vs 8min+）；
  dsh web 需要 `--expose-internals`（应用已内置，勿删）。
- 后台 bash 任务的工作目录落点在 `$HOME`（环境限制）：后台命令请用
  `cd <工作区> && ...` 或 `pnpm --dir <工作区>`。
- **无 TTY 时跑 `pnpm <script>` 必须带 `CI=true`**：pnpm 11 执行脚本前会做依赖状态检查，
  一旦认为 `node_modules` 需重建就会尝试清理，并因无 TTY 以
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 失败 —— 报错发生在**脚本真正运行之前**，
  很容易被误读成测试失败。
