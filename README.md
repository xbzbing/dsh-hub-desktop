# DSH Hub Desktop

个人使用的 Electron 桌面工具：统一管理多个 **dsh**（DeepSeek Harness）实例 —— 本地进程、
SSH 隧道、远程 HTTP 直连三种形态一站管理。认证对接 dsh-auth-gateway 协议
（密码 + TOTP + HttpOnly Cookie 注入），支持凭据保险库与已存密码静默登录。

## 功能特性

- **实例统一管理**：注册表本地落盘（原子写 + 滚动备份 + 损坏自愈 + 版本迁移）；
  向导式创建 → 启动 → 详情页启停 / 编辑 / 开窗 / 删除
- **三种传输**：`local`（spawn 本地进程）· `ssh`（隧道，看门狗指数退避自动重连）·
  `http`（远程直连）；统一状态通道，启停 / 开窗按 transport 分发
- **认证一体化**：网关五态探测识别（登录页 / OTP / onboarding / API 401 / 无需登录）；
  认证面板全状态流（密码 → 6 位 OTP / 备份码 → 锁定倒计时）；
  **已存密码静默登录**（勾选「记住密码」后，重启 / 会话失效无需重输密码 —— 密码绝不跨进程传递）
- **webview 集成**：分区 Cookie 注入（先注入再 loadURL）、302/401 请求拦截、会话失效信号驱动重登
- **凭据保险库**：系统钥匙串（safeStorage），显式勾选才落盘、默认不记住；取消勾选 / 忘记即时清除
- **审计日志**：显式白名单投影，绝不落凭据
- **SSH 安全**：TOFU 主机指纹确认（首次信任 / 变更一律拒绝），口令经内存通道瞬时传递
- **双语 + 明暗主题**：zh / en 全量 i18n（走查护栏防遗漏），OKLch 品牌 token
- **托盘 / 通知 / 自启**：可配置

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Electron 43 + electron-vite 5 + Vite 7 |
| UI | React 18 + zustand + 手写 CSS（OKLch 明暗双主题） |
| 语言 | TypeScript 5.9（strict + `noUncheckedIndexedAccess`） |
| 校验 | zod 4.6.5（唯一新增运行时依赖） |
| 测试 | Vitest 4（单测）· Playwright `_electron`（E2E）· 契约测试（对真实网关） |
| 工具链 | ESLint 9 flat + Prettier 3 · pnpm 11 · Node 22 |

> 刻意避开 vite 8 / TS 7 / React 19（版本线评审结论，勿升级）。

## 架构

```
src/
├─ shared/          框架无关核心（node + web 双工程共享，不 import electron）
│  ├─ endpoint.ts   URL 解析/归一化（协议优先、host:port 消歧、IPv6、回环检测）
│  ├─ contracts.ts  实例模型（zod 判别联合）+ IPC 通道常量 + IpcResult 信封 + 版本迁移
│  ├─ settings.ts   非敏感偏好（语言/主题/托盘/自启/通知）
│  ├─ i18n/         扁平 key → {zh,en} 文案目录
│  └─ bridge.ts     preload 桥接面类型 + app 通道常量
├─ main/            主进程（唯一处理 electron 全局件的地方）
│  ├─ index.ts      窗口 / app://hub 协议 + CSP / 装配
│  ├─ ipc/register.ts  全部 ipcMain.handle 单点注册；入参 zod 校验 → 错误信封
│  ├─ registry/     实例注册表：原子写 + 备份 + 自愈 + 迁移
│  ├─ transport/    local spawn / ssh 隧道 / http 直连
│  ├─ auth/         网关客户端 + 认证状态机 + 会话恢复 + 静默登录
│  ├─ webview/      分区 Cookie 注入、请求拦截、视图计划
│  ├─ vault/        凭据保险库（钥匙串，显式 opt-in）
│  ├─ audit/        审计日志（白名单投影）
│  └─ shell/        托盘 / 原生设置 / 通知 的可注入实现
├─ preload/         contextBridge 白名单，只暴露 dshHub.*
└─ renderer/        React 壳 + 视图 · zustand store · i18n 护栏
tests/e2e/          Playwright _electron
tests/upgrade/      升级路径与发布元数据护栏
scripts/release/    发布演练与校验和
design/             UI 视觉基线（HTML 原型）+ 品牌 token
```

**核心设计约定**（详见 `AGENTS.md`）：

- **IPC 信封**：所有通道返回 `{ok:true,value} | {ok:false,code,message}`，错误码稳定，
  渲染层按码表映射文案；新增通道走固定四步（contracts → register → bridge/preload → 测试）
- **框架无关核心**：shared / registry / transport / auth / vault / audit 不 import electron
- **实例模型**：`transport: local|ssh|http` × `authMode: auto|none|gateway`，
  transport 创建后不可变更

## 快速开始

前置：Node 22+、pnpm 11。

```bash
pnpm install
pnpm dev            # 启动 dev server + Electron 窗口
```

受限 / 沙箱环境下 install 需要附加参数（pnpm store 与 electron 缓存落到可写目录）：

```bash
pnpm install --store-dir=/tmp/pnpm-store --cache-dir=/tmp/pnpm-cache
ELECTRON_CACHE=/tmp/electron-cache node node_modules/electron/install.js  # postinstall 偶发跳过时
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | dev server + Electron 窗口 |
| `pnpm typecheck` | node + web + e2e 三工程类型检查 |
| `pnpm lint` | ESLint（flat config） |
| `pnpm test` | 单测（vitest） |
| `pnpm build` | 三端产物（E2E 前置） |
| `pnpm test:e2e` | Playwright `_electron` |
| `pnpm test:contract` | 对本地 dsh-auth-gateway 源码运行认证契约测试；需设置 `DSH_AUTH_GATEWAY_SRC=/path/to/dsh-auth-gateway` |

发布相关命令分为“本地打包与验证”和“源码发布”两类。当前 GitHub Release 采用 `source-only` 策略，只发布源码、tag 和 Release Note，不上传 `.app`、`.dmg`、`.zip`、`.exe`、自动更新元数据或校验和文件。使用者需自行准备构建环境并从源码构建。

本地打包命令仍保留，但生成的未签名、未公证产物只适用于开发、本机验证和受控测试：

```bash
pnpm dist:mac:zip      # mac zip，本地验证用
pnpm dist:mac          # 仅生成未封装的 macOS .app，本地验证用
pnpm dist:win          # Windows NSIS，本地验证用
pnpm release:checksums # 仅本地字节校验辅助工具
pnpm release:check     # source-only 发布演练，不检查 dist/ 资产
```

正式源码发布前，运行 `CI=true pnpm release:check -- --pre`，确认发布说明包含 `source-only` 分发模式。发布收口命令只创建 tag 和无资产 Draft Release；详见 [`docs/release-policy.md`](docs/release-policy.md)。恢复官方二进制分发前，必须具备 Apple Developer ID 签名、公证、干净机器验证和可复核的更新元数据校验。

> 无 TTY 环境跑 `pnpm <script>` 需带 `CI=true`（pnpm 11 依赖检查在无 TTY 时会中止）。

## 数据目录

- 运行时数据：`<userData>/`（可用环境变量 `DSH_HUB_DATA_DIR` 覆盖）；
  实例注册表在 `<userData>/registry/instances.json`
- 仓库内 `hub-data/` 为本地运行 / E2E 数据（已 gitignore；E2E 自动隔离到 `hub-data/e2e*`）

## 安全与凭据纪律

- 注册表 / 审计 / 日志 / 文档**绝不落**密码、OTP、Cookie、私钥；
  密码与 OTP 只经 IPC 参数瞬时传递并驻留内存
- 保险库写入需用户**显式勾选**（默认不记住）；降级模式（钥匙串不可用）绝不落盘
- 审计记录由白名单投影构造（禁止对象展开），从结构上杜绝凭据泄漏
- SSH 主机密钥 TOFU：首次确认指纹才放行，**指纹变更一律拒绝**，
  恢复只能显式遗忘该主机指纹
- 静默登录使用保险库已存密码时，密码不跨进程传递：主进程自取，渲染层无读回通道

## 文档

- 产品、设计与发布策略（入库）：`docs/PRD.md` · `docs/dsh-hub-desktop-design.md` ·
  `docs/desktop-implementation-plan.md` · [`docs/release-policy.md`](docs/release-policy.md) ·
  `design/dsh-hub-desktop.html` · `design/brand-spec.md`
- 任务追踪类文档（开发任务清单、评审报告、交付清单、打包 / 发布演练 / 安全走查报告等）
  为**本地文档**，按里程碑放 `docs/local/ms-<N>/`（当前 `ms-1`），不进 git
  （一次性任务追踪，见 `.gitignore`）
- 仓库级开发守则：`AGENTS.md`
