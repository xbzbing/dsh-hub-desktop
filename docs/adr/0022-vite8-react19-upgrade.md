# 0022. Vite 8 / React 19 升级与版本线调整

- 状态：已采纳
- 日期：2026-11-27

## 背景

AGENTS 原版本线把 Vite 固定在 7、React 固定在 18、TypeScript 固定在 5，跨大版本须先改红线。
2026-11-27 的依赖检查显示 Vite 8、React 19 已是稳定版，且用户明确允许调整 AGENTS 的版本线，
以安全、高效为准。需要判断哪些大版本能升、哪些受工具链 peer 约束必须暂缓。

## 决策

1. **Vite 7.3.8 → 8.3.8**：electron-vite 6.0.0 的 peer 已声明 `^6 || ^7 || ^8`，现有
   `@vitejs/plugin-react@5.2.0` 的 peer 也包含 `^8`。构建、单测、E2E 均通过后再合入。
2. **`@vitejs/plugin-react` 保持 5.2.0，不升 6.3.0**：6.x 要求 Vite 8 之外还引入
   oxc / rolldown-babel 等可选 peer，属于不必要的构建链变更；5.2.0 已正式支持 Vite 8。
3. **React 18.3.1 → 19.3.1**：同步 `react-dom`、`@types/react`、`@types/react-dom` 到 19。
   zustand 5 的 peer 是 `react >=18`；当前 renderer 没有使用被移除的 React 18 API，
   typecheck 无需改业务代码。
4. **TypeScript 保持 5.9.3，暂不升 7**：`typescript-eslint@8.74.0`（含 parser）的 peer 上限是
   `typescript <6.1.0`。在 lint 工具链支持 TS 7 之前强行升级会让类型检查与 lint 的编译器语义分叉，
   风险大于收益；等 typescript-eslint 发布支持版本后再单独评估。
5. **Electron 45.4.1 → 45.5.0**：按仓库既有的同 major 补丁策略跟进，含 renderer 崩溃修复；
   升级后跑完整门禁、E2E 与打包，并按 AGENTS 核对 `process.versions`。
6. **pnpm 保持 12.8.1**：12.23.0 自带更严格的供应链年龄校验，且 peer 解析会把
   `@types/node` 拉到未满年龄的版本，需要改锁文件策略或加豁免；本次不为 dev 工具升级扩大攻击面。
   随包分发的 pnpm 只升同线补丁 10.34.6 → 10.34.9。
7. **CI Actions 升到当前主版本**（checkout v7、setup-node v7、cache v6、upload-artifact v7、
   pnpm/action-setup v6）。这些属于 GitHub 托管的构建工具，不影响应用运行时；工作流 YAML 本地校验，
   实际 CI 结果以推送后的首轮运行为准。
8. **AGENTS 版本线改为 Vite 8 / React 19 / TypeScript 5.9**；「跨大版本仍须 ADR + 人工评估」不变。

## 后果

- 应用获得 Vite 8 的构建链与 React 19 的运行时更新；TS 7 与 plugin-react 6 的升级路径保持开放。
- `@types/node` 26.6.11 发布未满 pnpm 的供应链年龄，经用户明确要求加入
  `minimumReleaseAgeExclude`；其余依赖仍受年龄策略约束。
- 渲染层产物与打包体积需在本次升级后用 E2E 性能用例和一次实际打包复核；
  体积变化不作为否决依据，性能预算与运行稳定性才是。
- 若后续 typescript-eslint 支持 TS 7，应新增 ADR 或补充本篇后再升，不直接改 AGENTS 了事。

## 被否决的备选

- **TS 7 + typescript-eslint 8 忽略 peer 强行安装**：lint 解析器与 tsc 的语义可能分叉，
  冲突会在最难定位的地方爆，且无法用现有门禁证明安全。
- **Vite 8 + plugin-react 6**：多引入 oxc/rolldown-babel 可选 peer，构建链更复杂；
  5.2.0 已支持 Vite 8，没有收益支撑这份风险。
- **pnpm 12.23 一并升级**：需要为本可避免的 peer 版本改动供应链年龄策略，或等待其自然过期；
  dev 工具升级不改变产物，先保持现状。
- **Electron 46 alpha**：预发布渠道不进入主版本线，继续按同 major 补丁跟进。
