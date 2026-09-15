# AGENTS.md — DSH Hub Desktop

> 本文件是仓库级规则文件(agent 上下文基线,始终加载)。**进度追踪以 `docs/开发任务清单.md` 为准**,本文件只承载稳定不变的约定与事实。

## 项目是什么

个人使用的 Electron 桌面工具:统一管理多个 dsh(DeepSeek Harness)实例 —— 本地 spawn、SSH 隧道、远程 HTTP 直连;认证走 dsh-auth-gateway 协议(密码 + TOTP + HttpOnly Cookie 注入)。

- 需求基线:`docs/PRD.md`;架构:`docs/dsh-hub-desktop-design.md`;实现计划:`docs/desktop-implementation-plan.md`;任务:`docs/开发任务清单.md`
- UI 视觉基线:`design/dsh-hub-desktop.html`(视图以 `data-od-id` 对应);token 真理源:`design/brand-spec.md`(OKLch,明暗双主题)

## 技术栈(已评审定版)

- Electron 43 + electron-vite 5 + Vite 7 + React 18 + TypeScript 5.9(strict + `noUncheckedIndexedAccess`)
- Vitest 4(单测)· Playwright `_electron`(E2E)· ESLint 9 flat + Prettier 3 · pnpm 11 · Node 22
- zod 4.6.5(契约校验;唯一新增运行时依赖,理由已记录在任务清单 T2)
- **刻意避开**:vite 8 / TS 7 / React 19(版本线评审结论 R2,勿升级)

## 常用命令

```bash
pnpm dev            # dev server + electron 窗口
pnpm typecheck      # node + web + e2e 三工程(tsconfig ×3)
pnpm lint           # eslint(flat config)
pnpm test           # 单测(vitest,含 store/ipc/endpoint)
pnpm build          # 三端产物(E2E 前置)
pnpm test:e2e       # Playwright _electron(7 用例)
```

- 提交前必须:`pnpm typecheck && pnpm lint && pnpm test` 全绿;E2E 至少跑一次
- 提交信息:`feat|fix|chore|test|docs: 描述`(规则 2)

## 全局规则(源自开发任务清单 §0,违反需评审豁免)

1. **设计稿为准**:UI 以 `design/dsh-hub-desktop.html` 对应视图为基线;偏差必须记录理由。
2. **质量门**:每任务完成时三关全绿才提交;每个任务完成后做独立评审 + 通知(见「工作流」)。
3. **契约测试是安全网**(T7+):涉及 auth 协议的任何改动必须过 `pnpm test:contract`(对真实网关)。
4. **零新增运行时依赖**:引入新依赖需在评审时说明理由,默认拒绝。
5. **框架无关核心**:`src/shared`、registry、transport、auth **不 import electron**,保持可迁移;主进程层(ipc/、main/)例外。

## 架构地图

```
src/
├─ shared/          框架无关核心(node+web 双工程共享)
│  ├─ endpoint.ts   URL 解析/归一化(协议优先判定、host:port 消歧、IPv6、回环检测)
│  ├─ contracts.ts  实例模型(zod 判别联合)+ IPC 通道常量 + IpcResult 信封 + 版本迁移
│  └─ bridge.ts     preload 桥接面类型 + app 通道常量
├─ main/
│  ├─ index.ts      窗口 / app://hub 协议 + CSP / 装配(仅此处理 electron 全局件)
│  ├─ ipc/register.ts 全部 ipcMain.handle 单点注册;入参 zod 边界校验 → 错误信封
│  └─ registry/instance-store.ts 原子写+滚动备份+损坏自愈+迁移(不 import electron)
├─ preload/         contextBridge 白名单,只暴露 dshHub.*(类型与 shared 一致)
└─ renderer/        React 壳(T1 占位;T3 起按 data-od-id 逐个落地真实视图)
tests/e2e/          smoke(壳链路)+ registry(注册表端到端)
```

数据落盘:`<userData>/registry/instances.json`(userData 可由 `DSH_HUB_DATA_DIR` 覆盖);`hub-data/` 为运行时数据(已 gitignore)。

## 关键约定与模式

- **IPC 信封**:所有通道返回 `{ok:true,value} | {ok:false,code,message}`;错误码稳定(`invalid-input|not-found|io-error|internal`),渲染层按码表映射文案(PRD §8)。
- **实例模型**:`transport: local|ssh|http` 判别联合 × `authMode: auto|none|gateway`(auto 默认,连接时探测);`transport` 不可经 patch 变更(改形态 = 删除重建);跨变体补丁字段显式拒绝。
- **新增 IPC 通道的固定步骤**:① contracts.ts 加通道常量 + 类型;② register.ts 注册(入参经对应 zod schema);③ bridge.ts + preload 白名单同步;④ 测试(register.test 或 E2E)。
- **凭据纪律**:注册表/审计**绝不落密码、OTP、Cookie、私钥**;密码/OTP 只经 IPC 参数瞬时传递;SSH 密钥只引用路径不读取内容(agent 优先,TOFU)。
- 目录别名 `@shared → src/shared`,已在 electron.vite.config.ts / tsconfig×3 / vitest.config.ts / playwright 侧配置。

## 环境注意事项(2026-09 本机,含沙箱)

- `$HOME/pnpm-workspace.yaml` 会把所有子目录项目误判为工作区 → **本仓库已自建 `pnpm-workspace.yaml` 阻断**,勿删。
- 沙箱限制写 `~/Library`:`pnpm install/add` 需追加 `--store-dir=/tmp/pnpm-store --cache-dir=/tmp/pnpm-cache`;`npm view` 用 `--cache /tmp/npm-probe-cache`。
- Electron 二进制缓存 `ELECTRON_CACHE=/tmp/electron-cache`;若 install 后 `node_modules/electron/dist` 缺失,执行 `node node_modules/electron/install.js`(pnpm 偶发跳过 postinstall)。
- 受限环境跑 E2E:`DSH_HUB_E2E_ARGS="--no-sandbox --disable-gpu" pnpm test:e2e`(CI 自动带 `--no-sandbox` + xvfb);E2E 数据自动隔离到 `hub-data/e2e*`,不污染真实 userData。
- npm 装 dsh 运行时走内网 registry 极慢时,启动应用/验收脚本前设 `DSH_HUB_NPM_REGISTRY=https://registry.npmmirror.com`(实测 15s vs 8min+);dsh web 需要 `--expose-internals`(应用已内置,勿删)。
- 后台 bash 任务的工作目录落点在 `$HOME`(环境限制):后台命令请用 `cd <工作区> && ...` 或 `pnpm --dir <工作区>`。

## 工作流(用户已确认)

1. 按 `docs/开发任务清单.md` 顺序逐个实现任务,每任务完成后停下给验收结果。
2. **每任务独立评审**(code-review-and-quality 五轴):Required/Critical 必须修复并复审确认;Nit/Optional 自行判断。
3. 评审通过后 → **通知** 单聊 ``(机器人「知微」,凭据 `~/._config`;发消息用 `msg_send_single.sh  text "..."`)。
4. 新会话接续:读本文件 + `docs/开发任务清单.md`(含接续状态)+ 需要时 `docs/PRD.md` 与 `design/dsh-hub-desktop.html`。