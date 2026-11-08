# 0019. i18n 文案按语言拆分，完整性由类型约束保证

- 状态：已采纳
- 日期：2026-11-09

## 背景

文案目录 `src/shared/i18n/messages.ts` 已增长到 1656 行、753 个 key（其中 `detail.*` 355 个），单文件检索与 review 成本高。原设计把 zh 与 en 写在同一个 `{ zh, en }` 对象里，用「同一处声明」换取「漏译即编译错误」，扫描测试的豁免面也钉在这一个文件上（见 0006）。

将来可能支持更多语言：按领域拆会变成「语言 × 领域」的乘法，每加一种语言就要在每个领域文件里补一列；按语言拆则是「语言数」的加法。因此拆分轴选语言，聚合层也按「语言表注册表」设计，而不是写死两种语言。

## 决策

1. 文案按语言拆为 `src/shared/i18n/catalog/zh.ts` 与 `src/shared/i18n/catalog/en.ts`；两份文件的键顺序与分组注释保持一致，便于逐条比对。
2. 英文表以 `as const satisfies Record<keyof typeof ZH_MESSAGES, string>` 声明：缺键报 TS1360、多键报 TS2353，漏译与多余键仍是编译错误。
3. `src/shared/i18n/messages.ts` 降为聚合器：`CATALOGS` 以 `satisfies Record<Language, Record<MessageKey, string>>` 注册各语言表，对外导出按 key 合并的 `MESSAGES`（key → 语言映射）、`Message`、`MessageKey`、`MESSAGE_KEYS`。`@shared/i18n/messages` 的导入路径与 `t()` 的入参校验不变；合并处的 `Object.fromEntries(...) as ...` 是目录内唯一的类型断言。
4. 运行期兜底：`i18n.test.ts` 断言 zh/en 键数组相等、每条文案覆盖 `LANGUAGES` 声明的全部语言、`MESSAGE_KEYS` 与 zh 表等长。
5. 硬编码扫描的豁免粒度从「单个文件」改为「目录前缀 `src/shared/i18n/catalog`」。守护用例仍只允许这一条豁免，并新增「目录内每个源文件都被排除、聚合器与 `index.ts` 不被排除」的断言。

## 被否决的备选

- **按领域前缀拆（shell / wizard / detail / plugin-security …，中英仍成对）**：单文件可压到约 340 行，且改文案仍在同一处；但无法让中文与英文各自成表。当前规模下按语言拆已把单文件降到约 830 行，双语一致性由 `satisfies` 保证，因此未采用。
- **保持单文件**：检索与 review 成本随 key 数线性上升。
- **拆成语言表后再保留一张 `{ zh, en }` 配对表**：等于同一份文案存两遍，多一层失配风险，只为省掉一次类型断言，不划算。

## 后果

- 改一条文案需要同时改 `zh.ts` 与 `en.ts`，review 时按 key 对照；漏改一侧仍是编译错误。
- 新增语言（如 ja）：加一张 `satisfies Record<keyof typeof ZH_MESSAGES, string>` 的语言表、在 `Language` 声明与 `CATALOGS` 各注册一处；漏掉任一注册都是编译或测试失败。文案键集合以中文表为准，`Message` 是「语言 → 文本」的映射，不随语言数改动。
- 扫描豁免从文件放宽到目录：目录内新增语言文件不必再改豁免清单，代价是不再通过豁免清单的 diff 暴露「新增了文案文件」；守护用例改为遍历目录内全部源文件逐条断言。
