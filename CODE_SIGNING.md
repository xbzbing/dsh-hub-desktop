# Code signing policy

本政策适用于 DSH Hub Desktop 的 Windows 安装包（`DSH-Hub-Setup-<version>.exe`，NSIS 安装器）的 Authenticode 代码签名；macOS/Linux 产物不在签名范围之内。

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## 团队角色

| 角色 | 成员 |
| --- | --- |
| Committers / Reviewers（可修改源码并负责评审） | [@xbzbing](https://github.com/xbzbing) |
| Approvers（审批每次发布签名请求） | [@xbzbing](https://github.com/xbzbing) |

当前为单人维护项目，各角色由同一人承担；引入协作者后本节会同步更新，并保持「作者改动需评审、签名请求需审批」的分工规则。

## 签名范围与约束

- 只签名本仓库自己构建的产物：由 GitHub Actions（`windows-latest` 官方 runner）构建、与本仓库源码一一对应的 NSIS 安装器；不代签任何第三方或上游二进制。
- 可验证构建（origin verification）：签名请求只接受经 GitHub Workflow Artifact 通道提交的构建，来源分支限定 `main`（含发布 tag `v*`）；所有待签名构建的 job 都必须运行在 GitHub 托管 runner 上。
- 每次发布签名必须由 Approver 在 SignPath 后台**手动批准**后才执行。
- 任何人都可以检查已签名二进制的内容与构建来源（GitHub Actions 日志 + 源码对应），发现异常可按下述联系方式报告。
- 产物元数据：产品名固定为 `DSH Hub`，版本号取自 `package.json` 的 `version` 并经 `electron-builder` 写入资源，同一构建内所有产物一致。

## 隐私政策

完整隐私政策见 [PRIVACY.md](PRIVACY.md)。要点：本应用不收集任何用户个人数据，无遥测、分析、崩溃上报与自动更新；网络连接仅发往用户明确配置的 dsh 实例、SSH 主机、npm 镜像等目标；应用数据（注册表、凭据、日志、会话 Cookie）全部保存在用户本机。

## 合规基线

- 项目采用 OSI 批准的 MIT 许可证，无商业双授权。
- 不包含专有、非开源组件；不包含恶意软件、潜在不想要程序或黑客工具。
- 项目在 GitHub 公开维护，源码、构建脚本与 CI 配置均可在仓库中审查。

## 联系方式与违规报告

- 项目相关：GitHub Issues（<https://github.com/xbzbing/dsh-hub-desktop/issues>）
- SignPath Foundation 证书的涉嫌滥用举报：<mailto:support@signpath.io>