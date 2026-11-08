# 架构决策记录（ADR）

本目录记录 DSH Hub Desktop 的**重大决策**：改红线、改发布、改依赖、改测试策略。

- 与 `AGENTS.md` 的关系：AGENTS 只留规则本身（怎么做），ADR 留「为什么」与被否决的备选（为什么这么做、为什么不那么做）。AGENTS 相关节会链到对应 ADR。
- 编号与文件：`NNNN-标题.md`，一经合并不改写；推翻旧决策时新增一篇并在旧篇顶部标注「已被 NNNN 取代」。
- 约定（见 AGENTS「架构决策记录」节）：重大决策须随实现 PR 附 ADR；琐碎实现选择不写。

## 索引

| # | 决策 | 状态 |
| --- | --- | --- |
| [0001](./0001-process-layering.md) | 进程分层与「框架无关层不 import Electron」红线 | 已采纳 |
| [0002](./0002-zero-runtime-deps.md) | 运行时零 npm 依赖（zod 并入打包产物） | 已采纳 |
| [0003](./0003-ipc-envelope-and-enum-registry.md) | IPC 错误信封 + zod 边界校验 + 安装源以枚举传递 | 已采纳 |
| [0004](./0004-release-windows-unsigned.md) | 发布策略：windows-unsigned、资产白名单、无自动发布流水线 | 已采纳（决策 3 见 0008） |
| [0005](./0005-plugin-restart-parity-with-dsh.md) | 插件生效判定与 dsh 同口径（只看 HMR） | 已采纳 |
| [0006](./0006-i18n-hardcode-scan.md) | i18n 硬编码文案由扫描测试守护 | 已采纳 |
| [0007](./0007-e2e-dual-platform-and-hidden-mode.md) | E2E 双平台 + 隐藏模式与 keyring 处置 | 已采纳 |
| [0008](./0008-semi-automated-publish.md) | 半自动发布脚本：人工发起、逐步幂等、停点可控 | 已采纳 |
| [0009](./0009-e2e-data-dir-isolation.md) | E2E 数据目录隔离：只允许 `hub-data/`，静态守卫兜底 | 已采纳 |
| [0010](./0010-markdown-release-notes.md) | 更新内容按 Markdown 渲染（引入 micromark/mdast 生态，AST → React 元素） | 已采纳 |
| [0011](./0011-external-dsh-detection-by-process-tree.md) | 外部 dsh 探测按进程树排除 Hub 托管实例 | 已采纳 |
| [0012](./0012-stop-semantics-process-tree-drain.md) | 停止语义按「整棵进程树排空」判定 | 已采纳 |
| [0013](./0013-plugin-upgrade-remove-then-install.md) | 插件升级先停止并移除、再安装（与 dsh 官方 `updateBundle` 一致） | 已采纳 |
| [0014](./0014-instance-download-controlled-path.md) | 实例分区下载受控放行（主进程定路径 + 文件名清洗 + 对话框兜底） | 落盘方式被 0015 取代 |
| [0015](./0015-download-save-dialog.md) | 下载落点由用户在保存对话框确认（默认路径预填系统下载目录） | 已采纳 |
| [0016](./0016-workspace-find-page-first.md) | 工作区 ⌘/Ctrl+F 由页面优先响应，菜单快捷键兜底 | 已采纳 |
| [0017](./0017-plugin-install-security-check.md) | 插件安装前静态安全检查：danger 硬阻止、warn 可确认、应用级开关 | 已采纳 |
| [0018](./0018-heuristic-block-overridable.md) | 启发式检查的 blocked 允许确认后安装；结构性失败仍硬阻止 | 已采纳（部分取代 0017 覆盖口径） |
| [0019](./0019-i18n-catalog-split-by-language.md) | i18n 文案按语言拆分，漏译仍由 `satisfies` 保证编译期失败 | 已采纳 |
