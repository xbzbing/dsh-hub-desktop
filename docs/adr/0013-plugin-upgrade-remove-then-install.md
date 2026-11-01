# 0013. 插件升级改为「先停止并移除、再安装」，与 dsh 官方一致

- 状态：已采纳
- 日期：2026-11-01

## 背景

dsh 官方 `plugin-manager` 的 `updateBundle`（Web 插件页的 Update）分两支：

- 有 HMR：先 `removeBundle` 停止旧版本插件、卸载其模块并删除包映射，再 `installBundle` 装目标版本；目标版本装上后起不来时，把旧版本按原安装源装回去。
- 无 HMR：目标版本直接装在运行中的版本之上，返回 `restart-required`。

hub 此前只有一条路径：`dsh plugin add name@version` 直接覆盖安装，靠 `dsh-hmr` 按磁盘身份换模块代热生效。覆盖安装在 dsh 的规则里属于「安装已存在于 `dependencies` 的包」，与官方 Update 走的是不同分支；官方分支的正向收益是**新版本按全新装载启动**（模块身份、映射全部重建），而不是在原映射上做模块代替换。插件升级因此与 dsh web 面板的行为不一致，出问题时也难以对齐两处日志。

## 决策

`PluginManager.upgrade()` 按 dsh 官方 `updateBundle` 的口径实现：

1. 读 profile 加载清单，判定 HMR（沿用 ADR 0005 的 `hmrAvailable`）与插件升级前的启用状态。
2. 有 HMR 且列表能读出已装版本：`dsh plugin remove <name>` → `dsh plugin add <name>@<version>`。
3. 步骤 2 的安装失败时用 `dsh plugin add <name>@<oldVersion>` 装回旧版本（同安装源）；恢复也失败时抛出带两个原因的 `invalid-state`，明确「插件可能已不在 profile 中」。
4. 无 HMR，或列表读不出已装版本（无从移除、也无从回滚）：保持原来的覆盖安装，`application` 由 HMR 判定给出。
5. 移除会清掉 `dsh.profile.bundles` 里的条目，重装默认启用；因此升级前已禁用（有 host 半）的插件在装回后重新移出加载清单，保持「升级不改变启用状态」。

`application` 仍由 `defaultApplication(hmr)` 给出（ADR 0005 不变）：HMR 下移除+安装返回 `applied`，无 HMR 返回 `restart-required`。

## 后果

- hub 的升级流程与 dsh web 插件页一致：先停止并移除旧版本，再安装新版本；失败自动回装旧版本，不再需要在 dsh 侧手工补救。
- 升级确认框的「升级会短暂中断正在使用的工作区」提示与实际行为相符——旧版本插件确实会先停掉。
- 多一次 `dsh plugin` 调用的开销（remove + add），以及旧版本未知时退回覆盖安装的分支；两种情况的生效结论都由 HMR 判定，不引入新的重启语义。
- E2E 断言随之改为「一次 remove + 一次 add」，单测覆盖回滚成功、回滚失败、禁用态保留三种路径。
