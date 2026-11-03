# 0016. 工作区 ⌘/Ctrl+F 由页面优先响应

- 状态：已采纳
- 日期：2026-11-03

## 背景

Hub 用主进程 `before-input-event` 独占工作区视图的 ⌘/Ctrl+F，再打开顶栏查找条。dsh 页面里的面板（文件预览、Diff 等）也用同一快捷键打开自己的查找，并在 `keydown` 上调用 `preventDefault`；按键在到达页面之前就被主进程拦下，页面内的查找永远打不开。

工作区是 `WebContentsView`，没有浏览器「页面先处理、浏览器兜底」的分层。要恢复这层语义，必须先明确按键在主进程、页面与应用菜单之间的归属。

## 决策

1. 主进程不再在 `before-input-event` 里拦截 ⌘/Ctrl+F，按键原样交给页面。
2. 页面 `preventDefault` 时 Chromium 把该键视为已消费，未处理键盘事件不会回到主进程，应用菜单的快捷键也不触发——页面自己的查找生效。
3. 页面未处理时，未处理键盘事件回到主进程，由「编辑」菜单 `workspace-find` 项的 `CmdOrCtrl+F` accelerator 打开 Hub 顶栏查找条。菜单项与 accelerator 必须保留：它既是可发现入口，也是兜底路径。
4. 工作区持焦且 Hub 查找条打开时，Escape 仍由主进程截获：停止 `findInPage`、清除高亮并请渲染层收起面板。
5. 不 `preventDefault` 就打开自己查找的页面（dsh 的 Excel 预览即如此）会同时出现两处查找——这与浏览器里页面不 `preventDefault` 时浏览器查找照样打开一致，不做特判。

## 被否决的备选

- **注入工作区 preload 上报 `defaultPrevented`**：能精确知道页面是否消费，但要把第二个 preload 构建进产物、给远程实例页面增加 IPC 面，并处理导航与缓存视图的会话生命周期；菜单兜底已经提供同一信号，成本不抵收益。
- **保留拦截、改成「同时响应」**：Hub 查找条要抢焦点才能输入，会立刻把页面刚打开的查找框顶掉，视觉上只是多一条空查找条。
- **给 Hub 查找换快捷键（⌘⇧F / ⌘⌥F 等）**：与 dsh 已有的 fork 等快捷键冲突，也违背用户按 ⌘F 找内容的习惯。
- **用 `setIgnoreMenuShortcuts` 只屏蔽菜单、不拦页面**：方向相反——这里要保留菜单作为兜底，只要求页面优先。

## 后果

- dsh 面板内的查找恢复；普通页面与登录页仍可用 ⌘F 打开 Hub 查找条；「编辑 → 查找」保持不变。
- 行为依赖 Electron 的未处理键盘事件路径：菜单快捷键只在渲染进程未处理按键时执行（`PlatformHandleKeyboardEvent`）。E2E 的 `sendInputEvent` 不产生原生 `NSEvent`，无法触发菜单兜底；测试锁定「页面优先（主进程不拦截、页面收到按键）」与「菜单项仍带 accelerator」，原生兜底由 Electron 语义保证。
- 主进程不再需要 `isFindShortcut` 白名单，工作区输入过滤只保留会话切换所需的两类键。
