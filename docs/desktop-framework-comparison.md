# 桌面壳框架选型对比(Electron vs Tauri 2 vs 其他)

> 针对 dsh-hub-desktop 的实际需求(嵌入 dsh Web UI、auth-gateway 会话 Cookie 注入/拦截、ssh 与 dsh 子进程管理、跨平台)做的横向对比。结论先行:**Electron 是该场景的主流且仍是首选;Tauri 2 是唯一现实的替代;其余方案均有硬性短板。**

---

## 1. 生态事实:dsh 桌面项目都用的什么

以 GitHub 上主要 dsh desktop 项目的 `package.json` 为准核实(2026-09):

| 项目 | 框架 | 说明 |
|---|---|---|
| anywhere-labs/dsh-desktop(26.6k⭐) | **Electron 43.3** | 头号项目,`dsh-plugin-desktop` 包内 electron 依赖 |
| dataelement/dsh-desktop(6.5k⭐) | **Electron 43.4** | 手机桥(LAN+隧道)Electron 主进程实现 |
| lencx/Minke(642⭐) | **Electron 43.4** | 远程访问/Tailscale 集成在 Electron 内 |
| op7418/pilot-harness(276⭐) | Electron | README 明示 "Electron packages the local Harness runtime" |
| whitelonng/dshcode(714⭐) | Electron | README 明示 one-click Electron app |
| dsh-tauri-desk/deepseek-harness-desktop(2.1k⭐) | **Tauri 2** | 轻量派代表(5MB 安装包),自带 Node 侧车模式 |
| dsh-plugins/dsh-launcher(46⭐) | **Tauri 2** | 本地多实例启动器(纯本地,无 Cookie 需求) |
| A7m0spHere/dsh-phl / MochiNek0 等 | Tauri 2 | 本地实例管理器 |
| HDSL(Java/jpackage)、ding7015869(C#/WebView2)、LuxUmbra697(C#) | 原生 | 极少数,Windows 向 |

**规律**:做"本地单实例壳"的大项目几乎全在 Electron(体积/内存不是它们的首要矛盾);做"轻量本地多实例启动器"的新项目倾向 Tauri;**没有一个大项目用 Wails/Neutralino**。

---

## 2. 候选方案一览

| 方案 | 内核 | 后端语言 | 代表案例 |
|---|---|---|---|
| **Electron** | 捆绑 Chromium + Node | TS/JS | VS Code、Slack、Discord、Obsidian;dsh 三大项目 |
| **Tauri 2** | 系统 WebView(WKWebView/WebView2/WebKitGTK)+ Rust | Rust + TS | Spacedrive、RustDesk(部分)、dsh-tauri-desk |
| **Wails v2** | 系统 WebView + Go | Go + TS | 少量 Go 社区 GUI |
| **Neutralino.js** | 系统 WebView + 极简原生后端 | TS/JS | 轻量小工具 |
| **Pake** | Tauri 之上的"单页打包"壳 | Rust | 把某个 Web 页变成小应用(不适合本场景) |
| **原生工具包**(Qt WebEngine / .NET MAUI / Avalonia / Flutter) | 各自引擎 | C++/C#/Dart | 重开发成本,非 web 壳路线 |

---

## 3. 按本项目需求逐轴对比

评分:●●● 原生级支持 · ●● 可行但有代价 · ● 需自造或受限

| 需求轴 | Electron | Tauri 2 | Wails | Neutralino | 原生(Qt/MAUI) |
|---|---|---|---|---|---|
| 嵌入 dsh Web UI(webview) | ●●● | ●●● | ●●● | ●●● | ●●● |
| **会话 Cookie 注入(关键)** | ●●● `session.cookies.set` | ● 无官方 API,*见 §4 | ● 同 Tauri | ● 同 Tauri | Qt ●●(QWebEngineCookieStore),MAUI ● |
| **请求拦截(302→/login 检测)** | ●●● `webRequest.onHeadersReceived` | ● 需自建 | ● 需自建 | ● 需自建 | Qt ●●;MAUI ● |
| **SSH/dsh 子进程管理** | ●●● Node child_process | ●● Rust std::process 或 Node 侧车 | ●●● os/exec | ●● | ● |
| 杀进程树 | ●●● tree-kill 等成熟库 | ●● 平台 API | ●●● | ●● | ● |
| 钥匙串凭据 | ●●● safeStorage(mac Keychain/Win DPAPI/Linux libsecret) | ●● 官方 stronghold 插件 + 社区 keyring | ●● 自调 OS API | ● | ●●● 平台原生 |
| 自动更新 | ●●● electron-updater | ●● tauri-plugin-updater | ● 自造 | ● 自造 | ● 自造 |
| 托盘/通知/开机自启 | ●●● | ●●●(官方插件齐全) | ●● | ●● | ●● |
| 跨平台一致性 | ●●● Chromium 三平台一致 | ●● 三套系统 WebView 行为差异(测试面大) | ●● 同左 | ●● 同左 | Qt ●● / MAUI ● |
| 安装包体积 | ● 100MB+ | ●●● 5–15MB | ●●● 5–15MB | ●●● | ●● |
| 内存占用 | ● 高(常 300–800MB) | ●●● 显著更低 | ●●● 同左 | ●●● | ●● |
| 生态/文档/踩坑案例 | ●●● 最成熟 | ●● 快速增长中 | ● 偏小 | ● 小 | Qt ●● / MAUI ● |
| 团队语言匹配(本团队 TS) | ●●● 全栈 TS | ●● Rust 后端门槛 | ● Go 门槛 | ●●● TS | ● 门槛高 |

---

## 4. 决定性差异:auth-gateway 会话 Cookie

这是本项目独有的硬需求,也是 Electron 与 Tauri 拉开差距的地方:

**a) Electron(20 行内完成)**
```ts
await ses.cookies.set({
  url: 'http://127.0.0.1:30000/',
  name: 'dsh_auth', value: token,
  httpOnly: true, sameSite: 'strict', path: '/',
  expirationDate: Date.now()/1000 + 30*86400,
});
// + ses.webRequest.onHeadersReceived 检测 302→/login 与 401
```

**b) Tauri 2 / Wails / Neutralino:系统 WebView 不暴露 Cookie API**
- JavaScript 只能写非 HttpOnly Cookie——`dsh_auth` 是 **HttpOnly**,这条路直接堵死;
- 可行路线只有两条,都有明显代价:
  1. **平台私有 API**:macOS 用 `with_webview` 拿 WKWebView 写 `WKHTTPCookieStore`;Windows 拿 CoreWebView2 的 `CookieManager`——每个平台一份私有代码,Tauri 官方不承诺 API 稳定;
  2. **本地 Cookie 注入代理**:webview 不直连实例,改连 hub 自建的本地代理,由代理把会话 Cookie 加到上游请求(HTTP + WS 升级 + 文件上传流都要透传)——**相当于在桌面端里再实现一遍 auth-gateway 的转发面**。auth-gateway 作者自己都明确指出 WS 无限重连与文件上传流式转发是网关转发最难验证的两点。

结论:选 Tauri 意味着核心难点从"写登录状态机"变成"先造一个带 Cookie 的转发网关",风险与工作量都不可控。**Cookie 注入这条需求轴直接决定选型。**

---

## 5. 什么时候应该选 Tauri

- 目标是**纯本地实例管理**(无远程、无网关注入)——dsh-launcher 场景,Tauri 非常合适;
- 安装包体积/内存是产品首要卖点(5MB vs 100MB);
- 团队 Rust 能力强,且愿意为 Cookie 场景自研代理层;
- 对上一条的补充:dsh-tauri-desk 已经在用"Rust 编排 + Node 侧车"模式,说明即便 Tauri 派也不得不保留 Node 运行时做复杂逻辑——**对本项目而言这等于两者都要维护**。

---

## 6. 结论与建议

| 结论 | 内容 |
|---|---|
| 主流性 | **Electron 就是该生态的主流**:三个头部项目(26.6k / 6.5k / 642⭐)全部 Electron;Tauri 是第二名,集中在轻量本地器 |
| 本项目选择 | **保持 Electron**,理由按权重:① HttpOnly Cookie 注入/拦截 === 唯一复杂集成点(§4)② 进程管理(Node 一等公民)③ 全栈 TS ④ 生态先例最多 |
| 对冲措施 | 核心逻辑(registry / transport / auth / probe)写成**框架无关 TS 模块**,不 import electron;若未来产品化需要瘦身,可整体迁 Tauri + 代理层,migration cost 可控 |
| 不推荐 | Wails/Neutralino/Pake 在 Cookie 与进程管理上同 Tauri 的短板且生态更小;原生工具包开发成本最高,仅当全团队原生栈时才考虑 |

> 补充视角:Electron 的内存/体积代价对这个工具是**可接受的**——用户要常驻管理多个 dsh 进程(每个 dsh 本身就是 Node 进程),hub 的数百 MB 并不改变量级;而"远程实例 + 二次验证"这个差异化功能,恰恰只有 Electron 能低成本实现。