import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MESSAGES, MESSAGE_KEYS } from '@shared/i18n/messages'

/**
 * i18n 走查护栏（T11）—— 第四轮加固：把「默认受约束」写死成规则。
 *
 * 1. **扫描范围 = 整个 `src/` 树的目录遍历结果，不是人工登记的清单**。扩展名表为
 *    `.ts/.tsx/.css/.html`，从 `src/` 根递归（含嵌套子目录、CSS 伪元素文案、`src/renderer/index.html`
 *    的 `<title>`）。新加一个文件/目录即自动受约束 —— 没人“记得登记”也不会漏（复审 E3）。
 *    **四审 R-a 修复**:此前只扫 `src/renderer` + `src/main`，`src/shared/**`（端点错误文案、
 *    zod 校验文案**今天就经 setError / formatZodIssues 上屏**）与 `index.html` 完全在范围外。
 *    唯一的排除面是 `SOURCE_EXCLUSIONS`（被钉住的字面量清单）:文案目录
 *    `src/shared/i18n/messages.ts` 是**迁移的落点**，把它当硬编码文案登记等于让护栏自指。
 * 2. **判定单位是行**：注释（`//`、块注释、JSX 注释）不参与判定；剥离注释是**词法级**的 ——
 *    字符串、模板字面量、**正则字面量**里的 `//` 都不是注释，且**行号与真实文件一致**（E4/E10）。
 *    四审 R-b:此前的剥离器把正则里的 `\/\/` 当行注释起点，`/https?:\/\//; const X='打开网关登录页'`
 *    能整行蒙混过关（G3）。模板的 `${...}` 现在按**代码**处理，嵌套模板也正确（见 stripComments）。
 *    推论:模板字面量里的内容是**文案**(模板内容不剥离),哪怕它长得像注释 —— 例如
 *    `ASKPASS_HELPER_SOURCE` 里那行只写着「落到取消分支」的块注释是生成脚本的注释,在外层 TS
 *    里它只是字符串内容,所以必须被登记为债务,而不是靠“更聪明的注释剥离”抹掉(见下方用例)。
 * 3. **两种写法都算中文**：字面字符，以及 `\uXXXX` / `\u{XXXX}` 转义（E6）。
 * 4. **豁免只有三条出口，且全部被钉住**：① 语言选择器那一行；② 非渲染层 `console.*` 的实参
 *    （只进日志，不是用户可见文案，理由写在 NON_RENDERER_EXEMPTIONS 里）；③ 已登记的债务行。
 *    任何清单/钉值的增删都必须**有意修改本文件**，否则测试失败（E5：PENDING 曾被随意扩大；
 *    四审 R-c：`MIGRATED_PIN` 曾是 `[...MIGRATED]` 的派生副本，恒真）。
 *    注意 ③ 是「对**扫描全集**做集合比对」而不是「扫描时过滤掉已登记的行」:后者会让
 *    “有没有新增 / 有没有过期”两个方向同时失效(见 scanSources 的注释)。
 * 5. 纯扫描核心与文件系统解耦（scanSources 吃 `{path,text}[]`），所以“这些绕过方式必须被抓住”
 *    的用例全部用合成源码验证，不写真实目录。
 * 6. 非渲染层债务分两档登记:**(a) 用户可见、待做 code→文案迁移**（本护栏存在的理由）、
 *    **(b) 内部诊断、逐条写明为何不经过界面**。两档并集必须等于扫描到的集合（用例强制）。
 */

// ───────────────────────── 纯扫描核心（与文件系统无关，可直接单测） ─────────────────────────

/** 中日韩统一表意文字 + 中文标点 + 全角字符 */
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/

export interface SourceFile {
  /** 工作区相对 POSIX 路径（仅用于报告） */
  path: string
  text: string
}

export interface Violation {
  path: string
  /** 1-based 行号，与文件真实行号一致 */
  line: number
  /** 违规行（去注释后 trim 的代码文本） */
  text: string
}

export interface ScanOptions {
  /** 整行豁免：某行 trim 后命中即跳过**该行**，不会连带豁免同文件其它行 */
  allowedLiterals?: readonly RegExp[]
  /** 豁免 `console.*` 实参区间内的文案（主进程日志，只进终端） */
  logSinks?: boolean
}

const charAt = (text: string, index: number): string => text[index] ?? ''

/**
 * 前一个「有意义 token」的类别:决定 `/` 是除号还是正则字面量起点。
 * - `value`:**值之后** → `/` 是除号(`a / b`、`(a + b) / 2`、`arr[i] / 2`、`{ a: 1 } / 2`、`x++ / 2`);
 * - `operator` / `statement`:这里可以开始一个表达式或一条新语句 → `/` 是**正则**字面量起点。
 *   两者对 `/` 的判定相同,分开只是让「控制语句的 `)` 之后」「块语句的 `}` 之后」在代码里自解释
 *   (五审 R-b:把 `)`/`}` 一律当「值之后」正是 E1–E3 整行被吞的根因)。
 */
type TokenContext = 'value' | 'operator' | 'statement'

/** 这些关键字之后可以紧跟表达式,因此可以紧跟正则字面量(`return /re/`、`case /re/:`) */
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield'
])

/**
 * 这些关键字后面的 `(` 是**控制语句的括号**,它的 `)` 之后是一条新语句 ——
 * 所以 `if (ok) /re/.test(s)`、`while (ok) /re/.test(s)`、`for (;;) /re/.test(s)` 里的 `/` 是正则。
 * 普通括号的 `)` 之后是值(`(a + b) / 2`),`/` 仍是除号。
 * **例外**:`for await (` 的 `(` 前面一个词是 `await`(不是 `for`),见 `isForAwaitParen`。
 */
const CONTROL_PAREN_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with'])

/**
 * 六审 R6-1:`for await (…)` 的 `(` 前面一个词是 `await`,`for` 被它挡住 —— 只按
 * `CONTROL_PAREN_KEYWORDS.has(lastWord)` 判定会把该括号登记为**普通**括号,于是 `)` 把
 * 上下文置回 `value`(`:561`),`/` 被判成除号,正则体里的 `\/` 与收尾 `/` 在上下文判定
 * **之前**先命中 `//` 分行注释 → 整行剩余部分(含中文文案)被抹成空格(GREEN 漏报)。
 *
 * 此处向前回扫:`(` → 空白 → `await` → 空白 → 若为 `for` 则确认为控制括号。
 * 刻意**只认 `for await`** 这一形态:裸 `await (` 仍是普通括号,`/` 是除号
 * (反向对照 `await-paren-div.ts` 钉住,防止过度修复把真除号改判成正则)。
 */
const isForAwaitParen = (source: string, parenIndex: number): boolean => {
  let cursor = parenIndex - 1
  const skipSpaceBack = (): void => {
    while (cursor >= 0 && /\s/.test(charAt(source, cursor))) cursor -= 1
  }
  const wordBack = (): string => {
    const end = cursor + 1
    while (cursor >= 0 && /[A-Za-z0-9_$]/.test(charAt(source, cursor))) cursor -= 1
    return source.slice(cursor + 1, end)
  }
  skipSpaceBack()
  if (wordBack() !== 'await') return false
  skipSpaceBack()
  return wordBack() === 'for'
}

/** `{` 前面是这些**标点**时,它是对象字面量 / 解构模式,而不是块语句 */
const EXPRESSION_BRACE_AFTER_PUNCT = new Set(['=', '(', '[', ',', ':', '?'])

/**
 * `{` 前面是这些**关键字**时同理(`return { a: 1 }`、`export default { … }`)。
 * 刻意**不含** `void` / `typeof`:它们既能引出表达式,又能出现在**类型**位置 ——
 * `function f(): void {}` 的 `{` 是**函数体(块语句)**,把它当对象字面量会让其后的 `/re/` 退回除号,
 * 于是 E2 家族在「带返回值类型注解的函数」上重新漏报(实测)。
 */
const EXPRESSION_BRACE_AFTER_WORD = new Set([
  'await',
  'case',
  'default',
  'export',
  'return',
  'yield'
])

const isIdentStart = (char: string): boolean => /[A-Za-z_$]/.test(char) || char.charCodeAt(0) > 0x7f

const isIdentPart = (char: string): boolean =>
  /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) > 0x7f

/** JSX/HTML 标签名与属性名允许的字符(`-` 给 Web Component,`:` 给命名空间,`.` 给成员表达式) */
const isTagChar = (char: string): boolean => /[A-Za-z0-9_$.:-]/.test(char)

/**
 * 源码的语法模式 —— 决定要不要处理**文本节点**(五审 J1/J2/J3/J5):
 * `jsx` 认 `.tsx` 的 JSX 文本,`html` 认标签之间的 HTML 文本,`code` 是其余(.ts/.css)的纯代码扫描。
 * 文本节点是**真渲染出来的界面文案**,不是 TS 代码,所以必须保留(不能当注释抹掉)。
 */
export type StripMode = 'code' | 'jsx' | 'html'

/** 按扩展名选模式:未知扩展名一律 `code`(保守:不引入 JSX/HTML 文本态) */
export const modeForPath = (path: string): StripMode => {
  if (path.endsWith('.tsx')) return 'jsx'
  if (path.endsWith('.html')) return 'html'
  return 'code'
}

/**
 * 去掉注释，且**词法级地区分注释 / 字符串 / 模板字面量 / 正则字面量 / JSX-HTML 文本节点**：
 * - 行注释与块注释替换成等长空格（块注释保留其中的换行），因此**行号与列号都不变**；
 * - 字符串 / 模板 / 正则字面量原样搬运 —— 里面的 `//` 或 `/*` 不是注释（复审 E4；四审 G3）；
 * - 模板字面量的 `${...}` 表达式按**代码**递归处理，所以嵌套模板与其中的注释都能被正确识别；
 * - `.tsx` 的 JSX **文本节点**与 `.html` 标签之间的文本按**文本**保留：它们是真渲染出来的界面文案，
 *   不是 TS 代码 —— `<p>//中文</p>`、`<p>` 里以 `/*` 开头的中文、`<p>https://例子.中国</p>` 都必须被检出
 *   (五审 J1/J2/J3/J5;此前 `//` `/*` 一律当注释起点,这些整行被抹成空格 → 漏报)。
 *
 * **为什么不用 `ts.createScanner`（四审建议的方案）**：独立 scanner **没有解析器上下文**，
 * 它把 `/` 一律当除号 —— 正则识别是解析器在「需要表达式」时调 `reScanSlashToken` 才发生的。
 * 实测（`ts.createScanner(ScriptTarget.Latest, false, Standard, text)` 抽样 token）：
 * `const R = /https?:\/\//; const X = '打开网关登录页'` 得到的唯一注释 token 是
 * `//; const X = '打开网关登录页'` —— 与四审 G3 的绕过**一模一样**，等于没修。
 * 五审复核同一结论：把 scanner 换进来既救不了「`if (ok) /re/`」这类**语句位置的正则**，
 * 也完全看不见 JSX 文本节点(那是 parser 的产物)。所以这里用手写词法器 + token 上下文状态机。
 *
 * **已按 token 上下文处理的位置**(`/` 何时是除号):
 *   标识符 / 数字 / 字符串 / 模板 / 正则 / **普通括号的 `)`** / `]` /
 *   **对象字面量的 `}`** / `++` / `--` 之后 → 除号;
 *   其余位置(`return` `case` `=` `,` `(` `[` `{` `;` `:` `?` 各类运算符 /
 *   **控制语句 `if|while|for|switch|catch|with` 的 `)`** / **块语句的 `}`** / 行首) → 正则。
 *   块语句还是对象字面量由 `{` 的前一个 token 判定(`=`/`(`/`[`/`,`/`:`/`?` 或 `return` 等关键字 → 对象)。
 *   行首(上一行以值结尾)按 ASI 语义当**正则**:这里 JS 语义本身有歧义,取保守侧(`/` 当正则只“跳过”,
 *   `//` 不会因此被抹掉),代价是极少见的「除号换行延续」会多报。
 *
 * **仍是启发式 —— 而且两侧的出错方向不对称,所以这里逐条说清,不笼统声称「只会多报」**:
 * - `/` 判成正则而实为除号 → 只是**跳过**一段字符(注释分支优先,且「跳过」只原样搬运、不抹空格)→ **多报**;
 *   反过来把真正则判成除号,正则体内的 `\/` 可能与后一个 `/` 凑成 `//` → **漏报**。
 *   所以默认值是「正则」,只有明确处在「值之后」才判除号(见上面的位置清单)。
 * - JSX 起始判定 = `<` 后跟标识符/`>` 且处在「表达式可开始」的位置。泛型实参 `<T,>` 这类会被**误判成**
 *   JSX → 该区域按文本保留、其中的注释不再剥离 → **多报**;反过来,若某个真 JSX 文本节点没被判成 JSX,
 *   文本里的 `//` 仍会被抹掉 —— **这一侧是漏报**。兜底:JSX 只会出现在表达式位置,而那里 `context !== 'value'`。
 * - `.html`:`<!-- -->` 按 `-->` **等长抹成空格**(未闭合则不猜、保留为文本);
 *   `<script>`/`<style>` 正文按 HTML 规范在第一个 `</script`/`</style>` 处截断后**按代码**处理(注释照常剥离);
 *   标签之间的文本**原样保留**(那是真上屏文案,保留即正确)。`.html` 已知的多报面只有「未闭合的 `<!--`」
 *   (不猜 → 保留为文本);当前 `src/renderer/index.html` 没有任何 HTML 注释。
 * - 上一行以标识符结尾且真正的正则体内含 `\/`(如 `a\n/a\//`)这类跨行歧义已按上面「行首取正则」收口,
 *   但词法边界仍靠上下文推断,没有完整解析器;`.ts` 的 `<` 一律当泛型/比较,不认 JSX。
 * **任何分支都必须让 index 前进**(本文件曾因不推进的循环把整个测试套件挂死)。
 */
export function stripComments(source: string, mode: StripMode = 'code'): string {
  // 等长替换而不是拼接:注释位置换成空格、换行原样保留 —— 行号/列号与真实文件一致(E10)
  const chars = source.split('')
  // **可变**:`.html` 的 `<script>`/`<style>` 正文按 HTML 规范截断后临时收窄扫描窗口(见 scanRawElement)
  let length = chars.length
  let index = 0
  /** 只对 `.tsx` 开 JSX 文本态:`.ts` 里 `<` 是泛型/比较,绝不能当标签(那会把代码当文本、漏剥注释) */
  const jsx = mode === 'jsx'

  const blank = (from: number, to: number): void => {
    for (let cursor = from; cursor < to && cursor < length; cursor += 1) {
      if (chars[cursor] !== '\n') chars[cursor] = ' '
    }
  }

  /** 跳过字符串字面量（含转义；未闭合时在行尾收场，避免一个落单引号吞掉整个文件） */
  const skipString = (from: number, quote: string): number => {
    let cursor = from + 1
    while (cursor < length) {
      const char = charAt(source, cursor)
      if (char === '\\') {
        cursor += 2
        continue
      }
      cursor += 1
      if (char === quote || char === '\n') break
    }
    return cursor
  }

  /** 跳过正则字面量（含字符类 `[...]`、转义、flags）；未闭合时同样在行尾收场 */
  const skipRegExp = (from: number): number => {
    let cursor = from + 1
    let inClass = false
    while (cursor < length) {
      const char = charAt(source, cursor)
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === '\n') return cursor
      if (char === '[') inClass = true
      else if (char === ']') inClass = false
      else if (char === '/' && !inClass) {
        cursor += 1
        while (cursor < length && /[a-z]/i.test(charAt(source, cursor))) cursor += 1
        return cursor
      }
      cursor += 1
    }
    return cursor
  }

  /** 跳过模板字面量内容（`index` 已越过开头的反引号）；`${...}` 交给 scanCode 当代码处理 */
  const skipTemplate = (): void => {
    while (index < length) {
      const char = charAt(source, index)
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '`') {
        index += 1
        return
      }
      if (char === '$' && charAt(source, index + 1) === '{') {
        index += 2
        scanCode(true)
        continue
      }
      index += 1
    }
  }

  /** 跳过 JSX 起始标签:`<` 已在 index 上。返回 `true` = 有子节点(非自闭合) */
  const skipJsxOpenTag = (): boolean => {
    index += 1 // '<'
    while (index < length && isTagChar(charAt(source, index))) index += 1
    for (;;) {
      if (index >= length) return false
      const char = charAt(source, index)
      const next = charAt(source, index + 1)
      if (/\s/.test(char)) {
        index += 1
        continue
      }
      // 开标签结束 → 后面是**文本节点**
      if (char === '>') {
        index += 1
        return true
      }
      if (char === '/' && next === '>') {
        index += 2
        return false
      }
      // 属性之间的注释是**真注释**(JSX 允许,`AuthPanel.tsx` 的 `// D5:…` 就写在这里) —— 必须剥离
      if (char === '/' && next === '/') {
        let end = index
        while (end < length && charAt(source, end) !== '\n') end += 1
        blank(index, end)
        index = end
        continue
      }
      if (char === '/' && next === '*') {
        let end = index + 2
        while (end < length && !(charAt(source, end) === '*' && charAt(source, end + 1) === '/')) {
          end += 1
        }
        const stop = Math.min(end + 2, length)
        blank(index, stop)
        index = stop
        continue
      }
      // 属性里的 `{…}` 是 JSX 表达式容器 → 代码
      if (char === '{') {
        index += 1
        scanCode(true)
        continue
      }
      if (char === '"' || char === "'") {
        index = skipString(index, char)
        continue
      }
      // 属性名 / `=` / spread:逐字符前进(**任何分支都前进**,不会挂死)
      index += 1
    }
  }

  /**
   * 扫过 JSX 子节点:文本节点**原样保留**(界面文案就在这里 —— 五审 J1/J2/J3),
   * 嵌套标签递归,`{…}` 当代码。遇到本元素的结束标签即返回。
   */
  const scanJsxChildren = (): void => {
    for (;;) {
      if (index >= length) return
      const char = charAt(source, index)
      if (char === '<') {
        if (charAt(source, index + 1) === '/') {
          index += 2
          while (index < length && isTagChar(charAt(source, index))) index += 1
          while (index < length && /\s/.test(charAt(source, index))) index += 1
          if (charAt(source, index) === '>') index += 1
          return
        }
        scanJsxElement()
        continue
      }
      if (char === '{') {
        index += 1
        scanCode(true)
        continue
      }
      index += 1 // 文本节点:**原样保留**,绝不当注释抹掉
    }
  }

  /** 扫完一个完整的 JSX 元素(`<a/>`、`<a>…</a>`,允许嵌套与 Fragment `<>`) */
  const scanJsxElement = (): void => {
    if (skipJsxOpenTag()) scanJsxChildren()
  }

  /** 跳过 HTML 标签本身(含引号包裹的属性值);标签之间的**文本**由 scanHtml 原样保留 */
  const skipHtmlTag = (): void => {
    index += 1 // '<'
    for (;;) {
      if (index >= length) return
      const char = charAt(source, index)
      if (char === '"' || char === "'") {
        index = skipString(index, char)
        continue
      }
      index += 1
      if (char === '>') return
    }
  }

  /**
   * HTML 注释 `<!-- -->`:等长抹成空格(行号不变)。
   * 返回 `true` = 已处理(调用方可继续);`false` = **找不到 `-->`,一个字都不抹** ——
   * 调用方必须自行前进(见 scanHtml),否则本函数「不推进且被反复调用」会把整个测试套件挂死。
   */
  const skipHtmlComment = (): boolean => {
    const closeAt = source.indexOf('-->', index + 4)
    if (closeAt === -1) return false
    blank(index, closeAt + 3)
    index = closeAt + 3
    return true
  }

  /** 读一眼当前位置的标签名(`<script` → `script`),小写化;不是标签则返回 '' */
  const peekTagName = (): string => {
    let cursor = index + 1
    if (charAt(source, cursor) === '/') cursor += 1
    let end = cursor
    while (end < length && /[A-Za-z0-9]/.test(charAt(source, end))) end += 1
    return source.slice(cursor, end).toLowerCase()
  }

  /**
   * `<script>` / `<style>` 正文:按 HTML 规范在第一个 `</script`/`</style` 处截断(浏览器就是这么做的),
   * 截断区间**按代码**扫描(注释照常剥离)。找不到结束标签时**不猜** —— 留给文本态(只会多报)。
   */
  const scanRawElement = (name: string): void => {
    const closeAt = source.toLowerCase().indexOf(`</${name}`, index)
    if (closeAt === -1) return
    const outer = length
    length = closeAt
    scanCode(false)
    length = outer
    index = closeAt
  }

  /**
   * `.html`:标签之外的文本**原样保留**(`<title>数据目录控制台</title>` 这类界面文案就在这里 ——
   * 五审 J5)。标签、`<!doctype>`、HTML 注释按各自规则处理。
   */
  const scanHtml = (): void => {
    while (index < length) {
      const char = charAt(source, index)
      if (char === '<' && charAt(source, index + 1) === '!') {
        if (source.startsWith('<!--', index)) {
          // 已闭合 → 抹成空格;未闭合 → **不猜**:只前进一格,其余按文本保留(只会多报)
          // **必须前进**:`skipHtmlComment` 在找不到 `-->` 时一个字都不抹,直接 continue 会死循环
          if (skipHtmlComment()) continue
          index += 1
          continue
        }
        skipHtmlTag() // `<!doctype html>` 之类
        continue
      }
      if (char === '<' && /[A-Za-z/?]/.test(charAt(source, index + 1))) {
        const closing = charAt(source, index + 1) === '/'
        const tag = closing ? '' : peekTagName()
        skipHtmlTag()
        if (tag === 'script' || tag === 'style') scanRawElement(tag)
        continue
      }
      index += 1 // 文本节点:**原样保留**
    }
  }

  /**
   * 扫描一段「代码」：注释在这里被抹成空格，字符串/模板/正则整体跳过（内容原样保留）。
   * `stopAtBrace` 用于模板表达式与 JSX 表达式容器 —— 遇到**未配对的** `}` 即返回（该 `}` 属于它们）。
   */
  const scanCode = (stopAtBrace: boolean): void => {
    /** `value` = 除号;其余(operator/statement) = 正则。文件开头可以是以正则开头的表达式 */
    let context: TokenContext = 'operator'
    /** 最近一个有意义 token 的标点与词:只用于判断 `{` 是块语句还是对象字面量 */
    let lastPunct = ''
    let lastWord = ''
    /** 括号栈:`true` = 控制语句的括号(`if (…)`),其 `)` 之后是一条新语句 */
    const parenStack: boolean[] = []
    /** 花括号栈:`true` = 块语句,其 `}` 之后是新语句;`false` = 对象字面量,其 `}` 之后是值 */
    const braceStack: boolean[] = []
    /** 本行是否只见过空白:行首的 `/` 是 ASI 歧义点,取保守侧(见函数头) */
    let atLineStart = true
    let braceDepth = 0

    while (index < length) {
      const char = charAt(source, index)
      const next = charAt(source, index + 1)

      if (stopAtBrace && char === '}' && braceDepth === 0) {
        index += 1
        return
      }
      // —— 注释:只有不在字符串/模板/正则/文本节点里的 `//` `/*` 才是注释 ——
      //    这两种形态在**任何**位置都不可能是正则的起点,所以先于下面的 `/` 上下文判定
      if (char === '/' && next === '/') {
        let end = index
        while (end < length && charAt(source, end) !== '\n') end += 1
        blank(index, end)
        index = end
        continue
      }
      if (char === '/' && next === '*') {
        let end = index + 2
        while (end < length && !(charAt(source, end) === '*' && charAt(source, end + 1) === '/')) {
          end += 1
        }
        const stop = Math.min(end + 2, length)
        blank(index, stop)
        index = stop
        continue
      }
      // —— 正则字面量 vs 除号:由「前一个有意义 token」+ 行首歧义决定(见函数头说明) ——
      if (char === '/') {
        if (context === 'value' && !atLineStart) {
          index += 1
          context = 'operator'
          lastPunct = '/'
          lastWord = ''
          atLineStart = false
          continue
        }
        index = skipRegExp(index)
        context = 'value'
        lastPunct = '/'
        lastWord = ''
        atLineStart = false
        continue
      }
      if (char === '"' || char === "'") {
        index = skipString(index, char)
        context = 'value'
        lastPunct = char
        lastWord = ''
        atLineStart = false
        continue
      }
      if (char === '`') {
        index += 1
        skipTemplate()
        context = 'value'
        lastPunct = '`'
        lastWord = ''
        atLineStart = false
        continue
      }
      if (/\s/.test(char)) {
        // 换行重新打开「行首」:行首的 `/` 走保守侧(当正则跳过,不会抹掉 `//`)
        if (char === '\n') atLineStart = true
        index += 1
        continue
      }
      // —— JSX 标签(仅 .tsx):`<` 处在「表达式可开始」的位置且后跟标签名 ——
      //    五审 J1–J3:`<p>//中文</p>` 里的 `//` 此前被当行注释,整行文案被抹掉
      if (jsx && char === '<' && (isIdentStart(next) || next === '>') && context !== 'value') {
        scanJsxElement()
        context = 'value'
        lastPunct = '>'
        lastWord = ''
        atLineStart = false
        continue
      }
      if (isIdentStart(char)) {
        let end = index + 1
        while (end < length && isIdentPart(charAt(source, end))) end += 1
        const word = source.slice(index, end)
        index = end
        // 关键字之后可以开始一个表达式 → 正则;其余标识符是值 → 除号
        context = KEYWORDS_BEFORE_EXPRESSION.has(word) ? 'operator' : 'value'
        lastWord = word
        lastPunct = ''
        atLineStart = false
        continue
      }
      if (char >= '0' && char <= '9') {
        let end = index + 1
        while (end < length && /[0-9A-Za-z_.]/.test(charAt(source, end))) end += 1
        index = end
        context = 'value'
        lastWord = ''
        lastPunct = ''
        atLineStart = false
        continue
      }
      if (char === '(') {
        // `if (`/`while (`/`for (`/`switch (`/`catch (`/`with (` 的 `)` 之后是一条新语句
        // 六审 R6-1:`for await (` 的 `(` 紧随 `await` 而非 `for`,须由 isForAwaitParen 补判
        parenStack.push(CONTROL_PAREN_KEYWORDS.has(lastWord) || isForAwaitParen(source, index))
        index += 1
        context = 'operator'
        lastWord = ''
        lastPunct = '('
        atLineStart = false
        continue
      }
      if (char === ')') {
        // 五审 E1:控制语句的 `)` 之后是**新语句**,`/` 在那里是正则(`if (ok) /re/.test(s)`);
        // 普通括号的 `)` 之后是值,`/` 仍是除号(`(a + b) / 2`)
        const control = parenStack.pop() ?? false
        index += 1
        context = control ? 'statement' : 'value'
        lastWord = ''
        lastPunct = ')'
        atLineStart = false
        continue
      }
      if (char === '[') {
        index += 1
        context = 'operator'
        lastWord = ''
        lastPunct = '['
        atLineStart = false
        continue
      }
      if (char === ']') {
        index += 1
        context = 'value'
        lastWord = ''
        lastPunct = ']'
        atLineStart = false
        continue
      }
      if (char === '{') {
        // 五审 E2:`}` 之后是「新语句」还是「值之后」,取决于这个 `{` 是块语句还是对象字面量
        const isObject =
          EXPRESSION_BRACE_AFTER_PUNCT.has(lastPunct) || EXPRESSION_BRACE_AFTER_WORD.has(lastWord)
        braceDepth += 1
        braceStack.push(!isObject)
        index += 1
        context = 'operator'
        lastWord = ''
        lastPunct = '{'
        atLineStart = false
        continue
      }
      if (char === '}') {
        // 块语句 → 新语句(`if (ok) { f() } /re/.test(s)`、`function f(){} /re/`、`class X{} /re/`);
        // 对象字面量 → 值之后(`const x = { a: 1 } / 2` 仍是除号)
        const block = braceStack.pop() ?? true
        braceDepth -= 1
        index += 1
        context = block ? 'statement' : 'value'
        lastWord = ''
        lastPunct = '}'
        atLineStart = false
        continue
      }
      if ((char === '+' || char === '-') && next === char) {
        // `x++ / 2`:自增/自减之后是「值的位置」,故仍是除号
        index += 2
        context = 'value'
        lastWord = ''
        lastPunct = char
        atLineStart = false
        continue
      }
      index += 1
      context = 'operator'
      lastWord = ''
      lastPunct = char
      atLineStart = false
    }
  }

  if (mode === 'html') scanHtml()
  else scanCode(false)
  return chars.join('')
}

/** 把 `\uXXXX` / `\u{XXXX}` 还原成字符：转义写法的中文也必须被抓住（复审 E6） */
export function decodeUnicodeEscapes(text: string): string {
  return text.replace(
    /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g,
    (_match: string, braced: string | undefined, fixed: string | undefined) =>
      String.fromCodePoint(Number.parseInt(braced ?? fixed ?? '', 16))
  )
}

/** 该行里所有中日韩字符所在的列号（含转义写法，列号取转义序列的起点） */
export function cjkColumns(line: string): number[] {
  const columns: number[] = []
  const escaped = /\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4}/g
  let match = escaped.exec(line)
  while (match !== null) {
    if (CJK.test(decodeUnicodeEscapes(match[0]))) columns.push(match.index)
    match = escaped.exec(line)
  }
  for (let index = 0; index < line.length; index += 1) {
    if (CJK.test(charAt(line, index))) columns.push(index)
  }
  return columns
}

/** `console.*` 实参的字符区间 `[start, end)`：落在区间内的中文只进日志，不是用户可见文案 */
/**
 * 六审 R6-2:`/` 前面是这些字符(或行首)时,它是**正则字面量**起点,否则是除号。
 * 刻意**不含** `)` / `]` / 标识符 / 数字 —— 那些后面的 `/` 必须是除号
 * (`(a + b) / 2`、`arr[i] / 2`、`a / b`),不能改判成正则。
 */
const REGEX_START_AFTER = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^'
])

export function logArgumentRegions(code: string): Array<readonly [number, number]> {
  const regions: Array<readonly [number, number]> = []
  const pattern = /\bconsole\s*\.\s*(?:log|info|warn|error|debug|trace)\s*\(/g
  let match = pattern.exec(code)
  while (match !== null) {
    let index = match.index + match[0].length
    let depth = 1
    /** 上一个非空白字符 —— 判断 `/` 是正则起点还是除号(六审 R6-2) */
    let lastSignificant = ''
    while (index < code.length && depth > 0) {
      const char = charAt(code, index)
      if (char === '"' || char === "'" || char === '`') {
        const quote = char
        index += 1
        while (index < code.length) {
          if (charAt(code, index) === '\\') {
            index += 2
            continue
          }
          const inner = charAt(code, index)
          index += 1
          if (inner === quote) break
        }
        lastSignificant = quote
        continue
      }
      // 六审 R6-2:**必须跳过正则字面量**。此前只跳字符串,于是实参里含未配对 `(` 的正则
      // (如 `/\(/.test(raw)`)会把 `depth` 永久抬高 → 区间一路延到 `code.length`,
      // 该 `console.*` **之后整个文件**的中文都被当成「只进日志」而豁免(GREEN 漏报)。
      if (char === '/' && REGEX_START_AFTER.has(lastSignificant)) {
        index += 1
        let inClass = false
        while (index < code.length) {
          const inner = charAt(code, index)
          if (inner === '\\') {
            index += 2
            continue
          }
          if (inner === '\n') break
          index += 1
          if (inClass) {
            if (inner === ']') inClass = false
            continue
          }
          if (inner === '[') inClass = true
          else if (inner === '/') break
        }
        lastSignificant = '/'
        continue
      }
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
      if (!/\s/.test(char)) lastSignificant = char
      index += 1
    }
    regions.push([match.index + match[0].length, index])
    // 从实参右括号之后继续找下一个 `console.*` 调用。
    // **必须重新 exec**:`match` 不推进则 `while (match !== null)` 永不退出 ——
    // 这正是本文件此前「整个测试套件被 SIGTERM 杀死且无任何输出」的根因
    // (只设 `pattern.lastIndex` 不会改变 `match`,循环条件恒真)。
    pattern.lastIndex = index
    match = pattern.exec(code)
  }
  return regions
}

/**
 * 扫描一组源码，返回违规位置。逐行判定：一行只要有一处**未被豁免**的中日韩文案就算违规。
 *
 * 这里**没有**「已登记清单」这个选项:豁免会过滤掉已登记的行,而调用方又要拿同一份清单去
 * 判断“有没有新增/有没有过期”,两者相消后 `unregistered`/`stale` 永远只能有一个为空
 * (此前 `ceiling` 就是这么把自己弄成结构性不可满足的)。登记与否由调用方对**全集**做集合比对。
 */
export function scanSources(files: readonly SourceFile[], options: ScanOptions = {}): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    // 模式按路径选:`.tsx` 认 JSX 文本节点,`.html` 认标签之间的文本(五审 J1/J2/J3/J5)
    const code = stripComments(file.text, modeForPath(file.path))
    const regions = options.logSinks === true ? logArgumentRegions(code) : []
    const lines = code.split('\n')
    let lineStart = 0
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const start = lineStart
      lineStart += line.length + 1 // +1 = 换行符本身
      const text = line.trim()
      if (text === '') continue
      if (options.allowedLiterals?.some((pattern) => pattern.test(text)) === true) continue
      const offending = cjkColumns(line).some((column) => {
        const absolute = start + column
        return !regions.some(([from, to]) => absolute >= from && absolute < to)
      })
      if (offending) violations.push({ path: file.path, line: index + 1, text })
    }
  }
  return violations
}

/** 递归收集目录下的源文件（嵌套子目录同样收集 —— 复审 E3 的绕过点） */
export function collectSourceFiles(
  root: string,
  extensions: readonly string[],
  skip: (path: string) => boolean = () => false
): SourceFile[] {
  const found: SourceFile[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue
      const path = relative(process.cwd(), full).split(sep).join('/')
      if (skip(path)) continue
      found.push({ path, text: readFileSync(full, 'utf8') })
    }
  }
  visit(root)
  return found
}

// ───────────────────────── 规则数据（全部有注释，且改动都受钉值约束） ─────────────────────────

const SRC_ROOT = join(process.cwd(), 'src')
const RENDERER_PREFIX = 'src/renderer/'
const RENDERER_ROOT = join(SRC_ROOT, 'renderer')
const RENDERER_SRC = join(RENDERER_ROOT, 'src')
const COMPONENTS_DIR = join(RENDERER_SRC, 'components')
/** 全树的扩展名表:`.css`(伪元素文案)与 `.html`(`<title>` 直接上屏)同样算界面文案 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.css', '.html'] as const

/**
 * 允许保留的字面量:语言选择器按惯例用**该语言自身**书写（「中文」/English），
 * 翻译它反而会让用户找不到自己的语言。逐行精确匹配，只作用于这一行。
 */
const ALLOWED_LITERALS: readonly RegExp[] = [/^\{?language === 'zh' \? '中文' : 'English'\}?$/]

/**
 * 扫描的**唯一**排除面（四审 R-a:排除面必须显式且被钉住，不许有“扫不到的文件”这类暗门）。
 * `src/shared/i18n/messages.ts` 是**文案目录本身** —— 迁移的落点，里面每一行就是 zh 文案；
 * 把它当“硬编码待迁移文案”登记等于让护栏自指（也会把 284 条真文案淹进债务清单）。
 * 除它之外 `src/**` 全部受约束；任何新增排除都必须有意改这里 + `SOURCE_EXCLUSIONS_PIN`。
 */
const SOURCE_EXCLUSIONS: readonly string[] = ['src/shared/i18n/messages.ts']

/** SOURCE_EXCLUSIONS 的钉值:独立字面量副本（照 PENDING_PIN 的写法,不是派生副本） */
const SOURCE_EXCLUSIONS_PIN: readonly string[] = ['src/shared/i18n/messages.ts']

const isExcluded = (path: string): boolean => SOURCE_EXCLUSIONS.includes(path)

/** 测试文件不参与判定:里面的中文是测试名与断言数据,不是界面文案,也不进打包产物 */
const isTestFile = (path: string): boolean => /\.test\.tsx?$/.test(path)

/** 整树收集（`src/**`,递归,含渲染层 `index.html` 与 `src/shared`/`src/preload`） */
function collectScannedFiles(): SourceFile[] {
  return collectSourceFiles(
    SRC_ROOT,
    SOURCE_EXTENSIONS,
    (path) => isTestFile(path) || isExcluded(path)
  )
}

const isRendererPath = (path: string): boolean => path.startsWith(RENDERER_PREFIX)

/**
 * 非渲染层(主进程 + shared + preload)显式豁免表。每条都必须写清「为什么它不可能是用户可见文案」——
 * 这是非渲染层唯一被允许的“规则型”出口，不允许再出现别的整体豁免（禁止 blanket-exempt）。
 */
const NON_RENDERER_EXEMPTIONS = [
  {
    id: 'process-log',
    kind: 'console-args',
    levels: ['log', 'info', 'warn', 'error', 'debug', 'trace'],
    // 为什么不是用户可见文案:console.* 的实参只写进 Electron 主进程的 stdout/stderr
    // （终端 / 日志文件），不经过任何 IPC 通道，渲染层也拿不到 —— 界面上永远看不到。
    // 只豁免**实参区间内**的文案:同一行里若还有别的中文字面量（比如拼给 IPC 信封的 message），
    // 仍然判违规。
    reason: '主进程日志:只进终端/日志文件，不进入任何 UI 通道'
  }
] as const

const LOG_SINK_ENABLED = NON_RENDERER_EXEMPTIONS.some((entry) => entry.kind === 'console-args')

/**
 * 已完成文案迁移的渲染层文件（相对 `src/renderer/src`；`../App.tsx` 表示渲染层根组件）。
 * 说明:覆盖率不再依赖这份清单（全树默认受约束），它保留的意义是记录进度 + 钉住“不许缩小范围”。
 */
const MIGRATED = [
  '../App.tsx',
  // 复审 R1:store.ts 也含用户可见文案(toast),此前完全不在扫描范围内
  '../store.ts',
  'Sidebar.tsx',
  'SettingsView.tsx',
  'AuthPanel.tsx',
  'VaultCard.tsx',
  'EmptyView.tsx',
  'Toasts.tsx',
  'Modal.tsx',
  'UrlDetect.tsx',
  'KeyPreview.tsx',
  'HomeView.tsx',
  'SshDialogs.tsx',
  'DetailView.tsx',
  'Wizard.tsx'
]

/**
 * MIGRATED 的**钉值**:必须与 MIGRATED 完全一致。任何增删都必须在两处同时改 ——
 * 这就是“有意确认”的落点（评审 S11b:此前从清单里删一行就能缩小护栏范围）。
 *
 * **四审 R-c**:这里必须是**独立字面量副本**。此前写成 `[...MIGRATED]`（派生副本）,
 * `expect([...MIGRATED].sort()).toEqual([...MIGRATED_PIN].sort())` 恒真 —— 删掉 MIGRATED
 * 任一条目护栏仍全绿（假钉值）。现在删任一条目 → 本用例 RED。
 */
const MIGRATED_PIN: readonly string[] = [
  '../App.tsx',
  '../store.ts',
  'Sidebar.tsx',
  'SettingsView.tsx',
  'AuthPanel.tsx',
  'VaultCard.tsx',
  'EmptyView.tsx',
  'Toasts.tsx',
  'Modal.tsx',
  'UrlDetect.tsx',
  'KeyPreview.tsx',
  'HomeView.tsx',
  'SshDialogs.tsx',
  'DetailView.tsx',
  'Wizard.tsx'
]

/**
 * 尚未迁移、暂缓判定的渲染层文件（**工作区相对 POSIX 路径**，与 Violation.path 同域）。
 * 当前为空 —— 全部已迁移。登记一个文件等于“放过它的硬编码文案”，因此必须同时修改
 * PENDING_PIN（钉值）并在下面写明理由，否则测试失败（评审 E5:PENDING 曾被随意扩大）。
 */
const PENDING: readonly string[] = []

/** PENDING 的钉值:与 PENDING 完全一致；改动它 = 对“放过一个文件”的有意确认 */
const PENDING_PIN: readonly string[] = []

const isPending = (path: string): boolean => PENDING.includes(path)

/**
 * 一条非渲染层债务的**身份 = (文件路径, 文案)** —— 五审 N1:`path` 必须参与身份。
 * 此前只按**行文本**做集合比对(`Set(violations.map(v => v.text))`),于是把一条**已登记**的行
 * 原样搬进**新文件**时文案文本没变 → 护栏 20/20 GREEN(漏报);而同一位置换成新文案就 RED。
 * 现在新增任何 (路径, 文案) 站点(包括「把已登记的整行复制到新文件」)→ RED。
 * 行号刻意**不进**身份:同一文件里同文本的多处站点会折叠成一个(见下面清单的残留缺口注释),
 * 换行/插行也不会让整份清单假性过期。
 */
type DebtEntry = readonly [file: string, text: string]

/** 构造一条债务条目(只是让清单可读:比裸元组少一层括号噪音) */
const debt = (file: string, text: string): DebtEntry => [file, text]

/** 站点键:路径与文案之间用 `\u0000` 分隔(源码文本里不可能出现,不会撞键) */
const siteKey = (path: string, text: string): string => `${path}\u0000${text}`

/** 把站点键还原成可读形式,只用于失败信息 */
const readableSite = (key: string): string => key.replace('\u0000', ' :: ')

/**
 * 非渲染层硬编码文案债务清单（主进程 + shared + preload）—— 分两类登记,**只减不增**。
 *
 * (a) NON_RENDERER_COPY_DEBT_USER_VISIBLE = **用户可见、待迁移**的部分。
 *     这些中文会经非渲染层字段直接显示在界面上(渲染层不翻译这些字段,原样渲染):
 *     IPC 信封 `message` → toast(`result.message`);状态事件 `detail` → App.tsx / DetailView 的
 *     实例状态行;认证状态 `message` → AuthPanel 的 auth-message;探测 `evidence` → UrlDetect;
 *     口令提示语 → SshDialogs 的 askpass 弹窗副标题;指纹值 → 指纹确认弹窗;
 *     `shared/endpoint.ts` 的解析错误文案 → Wizard/UrlDetect 的 `setError(result.message)`;
 *     `shared/contracts.ts` 的 zod 文案 → `formatZodIssues` 折叠进 IPC 信封 message → 表单报错
 *     (后两组是四审 R-a 扩范围后新浮出来的,**今天就已经上屏**,见各组小标题)。
 *     迁移方式(PRD §8):非渲染层只发稳定 code,渲染层按 code 映射到 @shared/i18n/messages.ts。
 *     该迁移要动认证 wire 契约,尚未执行 —— 这些条目是本护栏存在的理由,不是“已确认无碍”。
 *     清单里的行按**到达界面的渠道**分组,便于按通道批量迁移。
 *
 * (b) NON_RENDERER_COPY_DEBT_INTERNAL = **内部诊断**,逐条写明“为什么不可能出现在界面上”。
 *     注意 (b) 不是“允许新增”的口袋:任何新中文都得先归到 (a)/(b) 之一(下面用例强制分档),
 *     而 (b) 的每一条都必须能指着代码说明它不经过 UI。
 *
 * 两层钉值:NON_RENDERER_COPY_DEBT 必须与扫描到的集合**完全相等**(多一条=未登记新增,
 * 少一条=已迁移却忘删),且 (a) ∪ (b) 必须恰好等于它。删条目时请把文案搬进
 * @shared/i18n/messages.ts 后一起改。
 *
 * **残留下的缺口(诚实记账,五审 N1 已闭合主口子)**:身份是 (路径, 文案),不含行号 ——
 * 因此在**同一个文件内**把一条已登记的整行再复制一份到别的位置,扫描结果折叠成同一个站点,
 * 不会被发现(跨文件复制必然 RED)。行号不进身份是刻意的:否则任何一次无关插行/换行都会让
 * 整份清单假性过期,护栏会被噪声淹没。真要逐站点精确,需把行号也钉进来并接受这种脆弱性。
 */
const NON_RENDERER_COPY_DEBT_USER_VISIBLE: readonly DebtEntry[] = [
  // —— IPC 信封 message（渲染层 toast 直接展示 result.message） ——
  debt('src/main/ipc/register.ts', ".refine((v) => v === null || v.trim() !== '', '口令不能为空串')"),
  debt('src/main/registry/instance-store.ts', "if (!current) throw new InstanceStoreError('not-found', `实例不存在：${id}`)"),
  debt('src/main/ipc/register.ts', "if (!deps.openDataDir) throw new DataDirOpenError('internal', '打开数据目录不可用')"),
  debt('src/main/ipc/register.ts', "if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)"),
  debt('src/main/shell/open-data-dir.ts', "if (dir === '') throw new DataDirOpenError('internal', '数据目录不可用')"),
  debt('src/main/registry/instance-store.ts', "return new InstanceStoreError('io-error', `注册表 IO 失败：${message}`)"),
  debt('src/main/ipc/register.ts', "return { ok: false, code: 'internal', message: '内部错误，请查看主进程日志' }"),
  debt('src/main/ipc/register.ts', "throw new InstanceStoreError('invalid-input', '只有 SSH 隧道实例才有主机指纹')"),
  debt('src/main/ipc/register.ts', "throw new InstanceStoreError('invalid-input', '未知的传输类型')"),
  debt('src/main/registry/instance-store.ts', "throw new InstanceStoreError('invalid-input', `字段 ${key} 不适用于 ${current.transport} 实例`)"),
  debt('src/main/ipc/register.ts', "throw new InstanceStoreError('invalid-state', '实例尚未运行，无法打开视图')"),
  debt('src/main/ipc/register.ts', "throw new InstanceStoreError('invalid-input', '未勾选「记住密码」，没有已保存的密码可用')"),
  debt('src/main/ipc/register.ts', "throw new InstanceStoreError('invalid-input', '保险库中没有该实例的已存密码')"),
  debt('src/main/ipc/register.ts', "throw new InstanceStoreError('not-found', `实例不存在：${parsed.instanceId}`)"),

  // —— 状态事件 detail（App.tsx / DetailView 的实例状态行） ——
  debt('src/main/local-runtime/local-runtime.ts', ": '分配端口并启动进程（端口区间不可用，改由 dsh 自动选择）'"),
  debt('src/main/transport/http-endpoint.ts', ": '按配置使用网关登录（T7 接入）'"),
  debt('src/main/transport/http-endpoint.ts', "? '按配置跳过登录认证'"),
  debt('src/main/local-runtime/local-runtime.ts', '? `分配端口并启动进程（端口 ${preferredPort}）`'),
  debt('src/main/local-runtime/runtime-installer.ts', "`安装 ${DSH_PACKAGE_NAME}@${version} 失败（exit ${result.code}）：${result.stderr.trim() || '无 stderr'}`"),
  debt('src/main/local-runtime/local-runtime.ts', "detail: '实例已在运行，忽略重复启动'"),
  debt('src/main/transport/http-endpoint.ts', "detail: '实例已在运行，忽略重复启动'"),
  debt('src/main/transport/ssh-tunnel.ts', "detail: '隧道已在运行，忽略重复启动'"),
  debt('src/main/transport/ssh-tunnel.ts', 'detail: `SSH 隧道已就绪（127.0.0.1:${entry.localPort} → ${entry.remoteLabel}）`'),
  debt('src/main/transport/ssh-tunnel.ts', 'detail: `SSH 隧道断开（${attribution.message}）；${entry.backoffMs / 1000}s 后自动重连`'),
  debt('src/main/local-runtime/local-runtime.ts', "detail: `启动超时（${Math.round(readyTimeoutMs / 1000)}s）：未解析到就绪 URL${entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''}`"),
  debt('src/main/local-runtime/runtime-installer.ts', 'detail: `安装 ${DSH_PACKAGE_NAME}@${version}`'),
  debt('src/main/local-runtime/local-runtime.ts', 'detail: `就绪 URL 无法访问（健康探测 ${healthProbeRetries} 次失败）：${url}`,'),
  debt('src/main/local-runtime/local-runtime.ts', 'detail: `已在 ${entry.home} 启动（dsh web）`'),
  // —— #2 运行时获取策略(hub → PATH → 下载需确认)新增的用户可见文案 ——
  debt('src/main/local-runtime/local-runtime.ts', "emit(id, 'starting', { detail: '解析运行时来源' })"),
  debt('src/main/local-runtime/local-runtime.ts', "emit(id, 'starting', { version: target, detail: `需要下载 dsh ${target}，等待确认` })"),
  debt('src/main/local-runtime/local-runtime.ts', 'detail: `需要下载 dsh ${target}，未获确认，已取消启动（hub 与 PATH 上均无可用运行时）`'),
  debt('src/main/local-runtime/local-runtime.ts', '? `使用本机 dsh ${version} 启动`'),
  debt('src/main/local-runtime/local-runtime.ts', ': `准备 dsh ${version} 运行时（首次需要安装，可能较慢）`'),
  debt('src/main/index.ts', "message: '未找到可复用的 dsh 运行时',"),
  debt('src/main/index.ts', 'detail: `hub 隔离目录与本机 PATH 上都没有可用的 dsh，需要下载 @deepseek-ai/dsh@${version}（首次下载可能较慢）。是否继续？`,'),
  debt('src/main/index.ts', "buttons: ['下载并启动', '取消'],"),
  debt('src/main/transport/ssh-tunnel.ts', 'detail: `建立 SSH 隧道（${localPort} → ${entry.remoteLabel}）`'),
  debt('src/main/local-runtime/local-runtime.ts', "detail: `进程意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）${entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''}`"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(entry.id, 'error', { detail: '远端 dsh 未就绪（就绪探测超时），即将自动重连' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(entry.id, 'starting', { detail: '等待输入 SSH 口令（不落盘）' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(entry.id, 'starting', { detail: `本地端口已重新分配为 ${port}` })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(entry.id, 'starting', { detail: `第 ${entry.reconnectCount} 次自动重连（${entry.url}）` })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(entry.id, 'stopped', { detail: '实例已删除' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'error', { detail: '服务器指纹未确认（或已变化），已拒绝连接' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'error', { detail: `SSH 进程启动失败：${error.message}` })"),
  debt('src/main/transport/http-endpoint.ts', "emit(id, 'error', { detail: `端点不可达：${url}（连接被拒或超时）`, url })"),
  debt('src/main/local-runtime/local-runtime.ts', "emit(id, 'error', { detail: `进程启动失败：${error.message}` })"),
  debt('src/main/transport/http-endpoint.ts', "emit(id, 'running', { url: existing.url, detail: '实例已在运行，忽略重复启动' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'starting', { detail: '分配本地端口' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'starting', { detail: '口令输入通道不可用，将尝试非交互认证（agent / 免密密钥）' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'starting', { detail: '校验服务器指纹' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'starting', { detail: '检测到隧道已中断，重新建立连接' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'starting', { detail: '隧道正在启动，忽略重复启动' })"),
  debt('src/main/transport/http-endpoint.ts', "emit(id, 'starting', { detail: `校验端点 ${url}` })"),
  debt('src/main/transport/http-endpoint.ts', "emit(id, 'starting', { url, detail: '探测认证模式' })"),
  debt('src/main/local-runtime/local-runtime.ts', "emit(id, 'stopped', { detail: '实例未在运行' })"),
  debt('src/main/transport/http-endpoint.ts', "emit(id, 'stopped', { detail: '实例未在运行' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'stopped', { detail: '实例未在运行' })"),
  debt('src/main/transport/http-endpoint.ts', "emit(id, 'stopped', { detail: '已停止' })"),
  debt('src/main/local-runtime/local-runtime.ts', "emit(id, 'stopped', { detail: '已取消启动' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'stopped', { detail: '已取消启动' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'stopped', { detail: '隧道已停止' })"),
  debt('src/main/local-runtime/local-runtime.ts', "emit(id, 'stopped', { detail: exited ? '已停止' : '已强制停止（SIGKILL）' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emitWaiting('服务器指纹已变化，已拒绝连接')"),
  debt('src/main/transport/ssh-tunnel.ts', "emitWaiting('等待确认服务器指纹')"),
  debt('src/main/transport/ssh-tunnel.ts', "entry.pendingReason = { kind: 'connect', message: '远端 dsh 未就绪' }"),
  debt('src/main/transport/ssh-tunnel.ts', "if (secret !== null) emit(entry.id, 'starting', { detail: '已收到口令，继续建立隧道' })"),
  debt('src/main/local-runtime/runtime-installer.ts', "if (versions.length === 0) throw new Error('registry 中没有可用的 dsh 版本')"),
  debt('src/main/transport/attribution.ts', "label: '主机名解析失败'"),
  debt('src/main/transport/attribution.ts', "label: '服务器指纹未确认或被更改（请在实例详情重新确认指纹）'"),
  debt('src/main/transport/attribution.ts', "label: '端口转发失败（本地端口被占或远端拒绝监听）'"),
  debt('src/main/transport/attribution.ts', "label: '连接被拒绝或中断'"),
  debt('src/main/transport/attribution.ts', "label: '连接被远端关闭'"),
  debt('src/main/transport/attribution.ts', "label: '连接超时'"),
  debt('src/main/transport/attribution.ts', "label: '鉴权失败（口令 / 密钥 / 权限）'"),
  debt('src/main/transport/attribution.ts', "message: `${feature.label}${detail ? `（${detail}）` : ''}`"),
  debt('src/main/transport/attribution.ts', "message: `SSH 会话异常退出（code=${code ?? 'null'}）` + (evidence ? `；${evidence}` : '')"),
  debt('src/main/transport/http-endpoint.ts', "return '无需登录认证，可直接访问'"),
  debt('src/main/transport/http-endpoint.ts', "return '检测到 dsh 内置浏览器认证（页面内自认证）'"),
  debt('src/main/transport/http-endpoint.ts', 'return `检测到登录认证（${detection.evidence}）`'),
  debt('src/main/transport/attribution.ts', "return { kind: 'closed', message: 'SSH 进程正常退出（退出码 0）' }"),
  debt('src/main/local-runtime/port-allocator.ts', 'throw new Error(`端口段 ${start}-${end} 内没有可用端口`)'),
  debt('src/main/local-runtime/runtime-installer.ts', 'throw new Error(`读取可用版本失败：${result.stderr.trim() || `exit ${result.code}`}`)'),
  debt('src/main/local-runtime/runtime-installer.ts', 'throw new Error(`非法版本号：${version}`)'),

  // —— 认证状态 message（AuthPanel 的 auth-message） ——
  debt('src/main/auth/gateway-client.ts', "'invalid-backup-code': '备份码无效',"),
  debt('src/main/auth/gateway-client.ts', "'invalid-credentials': '账号或验证码错误',"),
  debt('src/main/auth/gateway-client.ts', "'invalid-otp': '动态验证码错误',"),
  debt('src/main/auth/gateway-client.ts', "'onboarding-required': '需要先设置新的登录密码',"),
  debt('src/main/auth/gateway-client.ts', "'otp-not-enabled': '该实例未启用动态验证码',"),
  debt('src/main/auth/gateway-client.ts', "'otp-required': '请输入动态验证码或备份码',"),
  debt('src/main/auth/gateway-client.ts', "'otp-secret-missing': '实例的 OTP 配置异常，请联系管理员'"),
  debt('src/main/auth/gateway-client.ts', "'password-mismatch': '两次输入的密码不一致',"),
  debt('src/main/auth/gateway-client.ts', "'password-too-short': '密码太短',"),
  debt('src/main/auth/gateway-client.ts', "'password-too-simple': '密码强度不足',"),
  debt('src/main/auth/gateway-client.ts', "'payload-too-large': '请求体过大',"),
  debt('src/main/auth/gateway-client.ts', "'rate-limited': '尝试过于频繁，请稍后再试',"),
  debt('src/main/auth/gateway-client.ts', "'too-many-attempts': '失败次数过多，账号已临时锁定',"),
  debt('src/main/auth/gateway-client.ts', "message: '登录成功响应缺少会话 Cookie',"),
  debt('src/main/auth/gateway-state.ts', "message: '该实例需要先设置新的登录密码'"),
  debt('src/main/auth/gateway-state.ts', "message: '账号或验证码错误'"),
  debt('src/main/auth/gateway-client.ts', "message: error instanceof Error ? `网络错误：${error.message}` : '网络错误',"),
  debt('src/main/auth/gateway-client.ts', "message: rawMessage !== '' ? rawMessage : messageFor(code, `请求失败（HTTP ${status}）`),"),
  debt('src/main/auth/gateway-client.ts', "unauthenticated: '登录状态已失效，请重新登录',"),

  // —— 探测 evidence（UrlDetect 直接展示 detection.evidence） ——
  debt('src/main/auth/detect.ts', "evidence: '401 + dsh 内置 BrowserAuth 提示（webview 自认证）',"),
  debt('src/main/auth/detect.ts', "evidence: '401（无识别特征）',"),
  debt('src/main/auth/detect.ts', "evidence: `${status} → ${location || '(无 Location)'}（未识别的重定向）`,"),
  debt('src/main/auth/detect.ts', 'evidence: `${status} → ${location}（网关 onboarding 未完成）`,'),
  debt('src/main/auth/detect.ts', 'evidence: `${status} → ${location}（网关登录页重定向）`,'),
  debt('src/main/auth/detect.ts', 'evidence: `${status} → ${location}（网关要求二因素验证）`,'),
  debt('src/main/auth/detect.ts', 'evidence: `${status} 可直接访问（无需登录）`,'),
  debt('src/main/auth/detect.ts', "evidence: `401 JSON${error ? ` error=${error}` : ''}（网关 API 直探）`,"),
  debt('src/main/auth/detect.ts', 'evidence: `连接失败：${message}`,'),

  // —— askpass 提示语（口令弹窗副标题 SshDialogs.tsx:203 直接渲染 prompt） ——
  //    第 1 条在生成脚本里：ssh 正常都会把提示语作为 argv[2] 传进来，这条只是兜底；
  //    一旦命中，它会被脚本原样发给主进程并显示在弹窗里（与第 2 条主进程兜底同一句文案）。
  debt('src/main/ssh/askpass.ts', "const prompt = process.argv[2] || 'SSH 需要输入口令'"),
  debt('src/main/ssh/askpass.ts', "let prompt = 'SSH 需要输入口令'"),

  // —— 指纹展示值（指纹确认弹窗） ——
  debt('src/main/ssh/host-trust.ts', "return 'SHA256:<无法解析>'"),

  // —— 四审 R-a 扩范围后新登记:zod 校验文案（src/shared/contracts.ts） ——
  //    渠道:zod 的 message 经 `formatZodIssues`(contracts.ts:510-517)折叠成一条纯文本,
  //    塞进 IPC 错误信封 `message`(`register.ts` 的 invalid-input 分支)→ 渲染层 toast /
  //    表单报错。**今天就上屏**,不是理论风险:`Wizard.tsx` 的 create/patch 失败即展示它。
  //    迁移方式同 (a):改成稳定 code + 渲染层按 field/code 映射文案。
  debt('src/shared/contracts.ts', "const PORT_SCHEMA = z.number('端口必须是数字').int('端口必须是整数').min(1, '端口最小 1').max(65535, '端口最大 65535')"),
  debt('src/shared/contracts.ts', ".min(1, 'SSH 主机不能为空')"),
  debt('src/shared/contracts.ts', ".max(255, 'SSH 主机最长 255 字符')"),
  debt('src/shared/contracts.ts', ".regex(/^[A-Za-z0-9._\\-:[\\]]+$/, 'SSH 主机含非法字符（不允许空白 / 斜杠 / @）')"),
  debt('src/shared/contracts.ts', ".refine((value) => !value.startsWith('-'), 'SSH 主机不能以 - 开头')"),
  debt('src/shared/contracts.ts', ".refine(isValidSshHost, 'host[:port] 形态的端口必须在 1–65535，或主机名不含冒号')"),
  debt('src/shared/contracts.ts', "name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 字符'),"),
  debt('src/shared/contracts.ts', "notes: z.string().trim().max(2000, '备注最长 2000 字符').nullable().optional(),"),
  debt('src/shared/contracts.ts', "username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128, 'SSH 用户名最长 128 字符'),"),
  debt('src/shared/contracts.ts', ".refine((value) => tryParseEndpoint(value).ok, '端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）')"),
  debt('src/shared/contracts.ts', "name: z.string().trim().min(1, '名称不能为空').max(64).optional(),"),
  debt('src/shared/contracts.ts', "username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128),"),
  debt('src/shared/contracts.ts', ".refine((patch) => Object.keys(patch).length > 0, '补丁不能为空')"),
  debt('src/shared/contracts.ts', "schemaVersion: z.number('schemaVersion 必须是数字').int().min(1),"),

  // —— 四审 R-a 扩范围后新登记:端点解析错误文案（src/shared/endpoint.ts） ——
  //    渠道:`EndpointParseError.message` → `register.ts` wrap 的 invalid-input 信封 message
  //    → `Wizard.tsx:83/120` 与 `UrlDetect.tsx:65` 的 `setError(result.message)` **直接上屏**。
  //    这些文案刻意不回显 input(安全评审 Finding 1),所以它们是稳定的静态中文 ——
  //    迁移同样只需把静态文案换成 code。
  debt('src/shared/endpoint.ts', "throw new EndpointParseError('empty', input, '端点地址不能为空')"),
  debt('src/shared/endpoint.ts', "throw new EndpointParseError('missing-host', input, '端点地址缺少主机名')"),
  debt('src/shared/endpoint.ts', "throw new EndpointParseError('malformed', input, '无法解析端点地址')"),
  debt('src/shared/endpoint.ts', "throw new EndpointParseError('credentials-not-allowed', input, '端点地址不能内嵌用户名或密码')"),
  debt('src/shared/endpoint.ts', "throw new EndpointParseError('query-not-supported', input, '端点地址不支持查询参数')"),
  debt('src/shared/endpoint.ts', "throw new EndpointParseError('hash-not-supported', input, '端点地址不支持锚点')"),
  debt('src/shared/endpoint.ts', "throw new EndpointParseError('invalid-port', input, '端口不合法')"),
  debt('src/shared/endpoint.ts', "throw new EndpointParseError('unsupported-scheme', input, '仅支持 http / https 协议')")
]

/**
 * (b) 内部诊断:中文只进日志 / 被吞掉 / 当前无消费者,渲染层拿不到这些字段。
 * 每条的理由见所属分组的小标题。
 */
const NON_RENDERER_COPY_DEBT_INTERNAL: readonly DebtEntry[] = [
  // —— askpass helper 脚本内容（写盘后由 ssh 子进程执行，脚本正文从不渲染）：脚本头注释、
  //    catch 分支注释、三处 stderr 日志，以及包装脚本 askpass.sh 里的 shell 注释 ——
  debt('src/main/ssh/askpass.ts', "'# 由 DSH Hub 运行时写入：用自带 Node 执行 askpass helper（不依赖 PATH 中的 node）',"),
  debt('src/main/ssh/askpass.ts', '/* 落到取消分支 */'),
  debt('src/main/ssh/askpass.ts', 'export const ASKPASS_HELPER_SOURCE = `// 由 DSH Hub 运行时写入；把 ssh 的口令提示转发给主进程，答案只经 stdout 回给 ssh。'),
  debt('src/main/ssh/askpass.ts', "process.stderr.write('askpass: DSH_HUB_ASKPASS_SOCKET 未设置\\\\n')"),
  debt('src/main/ssh/askpass.ts', "process.stderr.write('askpass: 等待用户输入超时\\\\n')"),
  debt('src/main/ssh/askpass.ts', "process.stderr.write('askpass: 通道失败 ' + error.message + '\\\\n')"),

  // —— 注册表损坏隔离原因:只进 console.warn 与隔离文件名,不进任何 IPC/状态字段 ——
  debt('src/main/registry/instance-store.ts', "await quarantineCorruptFile('JSON 解析失败')"),
  debt('src/main/registry/instance-store.ts', 'await quarantineCorruptFile(`schema 校验失败：${reason}`)'),
  debt('src/main/registry/instance-store.ts', 'await quarantineCorruptFile(`schemaVersion=${from} 高于当前 ${REGISTRY_SCHEMA_VERSION}，拒绝降级`)'),
  debt('src/main/registry/instance-store.ts', 'await quarantineCorruptFile(`缺少 schemaVersion ${v} → ${v + 1} 的迁移器`)'),

  // —— 普通 Error(message 为中文):IPC 边界统一换成稳定码的固定文案(register.ts wrap 的 internal),明细只进主进程日志;或被调用方 catch 后只 console.error ——
  debt('src/main/ssh/key-preview.ts', "else reject(error ?? new Error('ssh -G 未返回任何配置'))"),
  debt('src/main/vault/vault.ts', "if (password === '') throw new Error('空密码不写入 vault')"),
  debt('src/main/vault/vault.ts', "if (session.value === '') throw new Error('空会话不写入 vault')"),
  debt('src/main/vault/vault.ts', 'throw new Error(`未勾选「${field}」,拒绝写入 vault`)'),

  // —— vault 的 onError 回调:缺省实现是 console.error('[vault] 操作失败：', error),只进日志 ——
  debt('src/main/vault/vault.ts', "onError(new Error('vault 会话载荷不是合法 JSON,已丢弃'))"),
  debt('src/main/vault/vault.ts', "onError(new Error('vault 文件格式不符,已忽略'))"),

  // —— ssh-keyscan 失败被 ensureTrust 的 catch {} 吞掉(不判 TOFU、不显示),交给 ssh 自己连接并归因 ——
  debt('src/main/ssh/host-trust.ts', "else reject(error ?? new Error('ssh-keyscan 未返回任何公钥'))"),

  // —— 工厂参数断言(调用方传常量):纯程序员错误,不会出现在界面上 ——
  debt('src/main/auth/backoff.ts', "if (!Number.isInteger(limit) || limit < 1) throw new Error('并发上限必须是正整数')"),

  // —— 当前**没有任何消费者**:backoff 的 reason 只写不读;auth-client 的 evidence 被两处 probe 调用方丢弃(register.ts:344 / index.ts:630),session-restored 分支 message 置 null ——
  debt('src/main/auth/auth-client.ts', "evidence: '已存会话有效（静默恢复）',"),
  debt('src/main/auth/backoff.ts', "reason = why ?? '请求过于频繁，已暂停自动重试'")
]

/**
 * 两份清单的并集:(a) 用户可见待迁移 + (b) 内部诊断。
 * 当前 **(a) 129 个 (路径, 文案) 站点 / (b) 20 个 —— 去重文案后 125 + 20 = 145 条**。
 * 三个文案在两个/三个文件里各有一处(如 `已取消启动` 同时在 local-runtime 与 ssh-tunnel),
 * 身份含路径后它们必须逐站点登记,所以站点数比文案数多 4。
 * 下面「主进程文案受约束」用例把它与扫描结果钉成等号。
 */
const NON_RENDERER_COPY_DEBT: readonly DebtEntry[] = [
  ...NON_RENDERER_COPY_DEBT_USER_VISIBLE,
  ...NON_RENDERER_COPY_DEBT_INTERNAL
]

// ───────────────────────── 用例 ─────────────────────────

const formatViolations = (violations: readonly Violation[]): string =>
  `以下位置仍有硬编码文案，应改用 t('...'):\n` +
  violations
    .map((violation) => `  ${violation.path}:${violation.line}  ${violation.text}`)
    .join('\n')

const COPY_DEBT_HINT = [
  '',
  '处置方式(二选一):',
  '  1. 用户可见(会经 IPC message / 状态 detail / 认证 message / 探测 evidence / zod 校验文案 /',
  '     端点解析错误文案 / 提示语到达界面):文案搬进 @shared/i18n/messages.ts，渲染层按',
  '     code / key 展示，并把该行登记进 NON_RENDERER_COPY_DEBT_USER_VISIBLE',
  '     (推荐;这一步涉及 wire 契约，要单独做);',
  '  2. 确属非用户可见(例如只进日志/被 catch 吞掉/当前无消费者):登记进 NON_RENDERER_COPY_DEBT_INTERNAL，',
  '     并在该分组的小标题里写明为什么它不可能出现在界面上 —— 这是对“债务只减不增”的有意确认，',
  '     不要为了变绿放宽规则。'
].join('\n')

function migratedPath(name: string): string {
  return name.startsWith('../') ? join(RENDERER_SRC, name.slice(3)) : join(COMPONENTS_DIR, name)
}

/**
 * 双向比对:**扫描到的站点** vs **已登记站点**,身份都是 (路径, 文案)(五审 N1)。
 * - `unregistered` = 扫到但没登记 → 新增文案,**或把已登记的整行复制进新文件**;
 * - `stale` = 登记了但没扫到 → 已迁移却忘删,或文件被改名/删除。
 * 抽成纯函数是为了能对**合成源码**直接断言(见下面 N1 的钉住用例),不必真的往仓库里放文件。
 */
export function diffDebt(
  violations: readonly Violation[],
  registered: readonly DebtEntry[]
): { unregistered: string[]; stale: string[] } {
  const observed = [...new Set(violations.map((violation) => siteKey(violation.path, violation.text)))]
    .sort()
    .map(readableSite)
  const pinned = registered.map(([file, text]) => siteKey(file, text)).sort().map(readableSite)
  const observedSet = new Set(observed)
  const pinnedSet = new Set(pinned)
  return {
    unregistered: observed.filter((key) => !pinnedSet.has(key)),
    stale: pinned.filter((key) => !observedSet.has(key))
  }
}

describe('i18n 走查护栏（T11 全界面无遗漏）', () => {
  it('渲染层整树(.ts/.tsx/.css/.html,递归)默认受约束:不含硬编码中日韩文案', () => {
    const files = collectScannedFiles().filter((file) => isRendererPath(file.path))
    // 反“空扫”:遍历不到文件时,下面的断言会毫无意义地变绿
    expect(files.length, '渲染层应能遍历到源文件(否则这条护栏是空转)').toBeGreaterThan(15)
    // 四审 G2:`src/renderer/index.html` 此前完全不收(.html 不在扩展名表里),改 `<title>` 为中文仍绿
    expect(
      files.some((file) => file.path === 'src/renderer/index.html'),
      '渲染层 index.html 必须在扫描集合内(四审 G2:否则改 <title> 不会被抓住)'
    ).toBe(true)
    const violations = scanSources(
      files.filter((file) => !isPending(file.path)),
      { allowedLiterals: ALLOWED_LITERALS }
    )
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it('新增文件默认受约束:渲染层根目录、嵌套子目录、CSS 与 index.html 里的文案都会被扫到', () => {
    // 复审 E3 的三种逃逸:根目录新文件 / components/nested/x.tsx / CSS-in-JS 文案
    // 四审 G2 的第四种:index.html 的 `<title>`
    const synthetic: SourceFile[] = [
      { path: 'src/renderer/src/NewView.tsx', text: 'export const A = () => <p>硬编码文案</p>\n' },
      {
        path: 'src/renderer/src/components/nested/x.tsx',
        text: 'export const B = () => <p>嵌套目录文案</p>\n'
      },
      {
        path: 'src/renderer/src/styles-extra.css',
        text: '.x::after { content: "伪元素文案"; }\n'
      },
      {
        path: 'src/renderer/index.html',
        text: '<!doctype html>\n<html>\n  <head>\n    <title>数据目录控制台</title>\n  </head>\n</html>\n'
      },
      { path: 'src/renderer/src/clean.ts', text: 'export const c = 1\n' }
    ]
    const violations = scanSources(synthetic, { allowedLiterals: ALLOWED_LITERALS })
    expect(violations.map((violation) => `${violation.path}:${violation.line}`)).toEqual([
      'src/renderer/src/NewView.tsx:1',
      'src/renderer/src/components/nested/x.tsx:1',
      'src/renderer/src/styles-extra.css:1',
      'src/renderer/index.html:4'
    ])
  })

  it('目录遍历是递归的:嵌套子目录里的新文件同样会被收集(复审 E3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'i18n-guard-'))
    try {
      mkdirSync(join(dir, 'a/b/c'), { recursive: true })
      writeFileSync(join(dir, 'root.tsx'), 'export const a = 1\n')
      writeFileSync(join(dir, 'a/b/c/deep.tsx'), 'export const b = 2\n')
      writeFileSync(join(dir, 'note.css'), '.a {}\n')
      writeFileSync(join(dir, 'index.html'), '<title>DSH Hub</title>\n')
      writeFileSync(join(dir, 'skip.test.tsx'), 'export const c = 3\n')
      const found = collectSourceFiles(dir, SOURCE_EXTENSIONS, isTestFile)
      expect(found.length, '只应收集到非测试的 .ts/.tsx/.css/.html').toBe(4)
      const paths = found.map((file) => file.path)
      expect(paths.some((path) => path.endsWith('root.tsx'))).toBe(true)
      expect(paths.some((path) => path.endsWith('a/b/c/deep.tsx'))).toBe(true)
      expect(paths.some((path) => path.endsWith('note.css'))).toBe(true)
      expect(paths.some((path) => path.endsWith('index.html'))).toBe(true)
      expect(paths.some((path) => path.endsWith('skip.test.tsx'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('扫描范围是整个 src 树:shared / preload / main / index.html 都在集合里(四审 R-a)', () => {
    // 四审 G1:`src/shared/**` 此前完全不扫(add 中文常量仍绿)。这里把范围本身钉成断言:
    // 一旦有人把根目录从 `src/` 缩回 `src/renderer`+`src/main`,这条用例先失败。
    const paths = collectScannedFiles().map((file) => file.path)
    // 四个目录 + 渲染层 index.html 都必须有代表文件(缺任一个都说明范围被缩回去了)
    for (const required of [
      'src/main/index.ts',
      'src/shared/endpoint.ts',
      'src/shared/contracts.ts',
      'src/shared/settings.ts',
      'src/shared/bridge.ts',
      'src/preload/index.ts',
      'src/renderer/index.html'
    ]) {
      expect(paths.includes(required), `${required} 必须被扫描到(四审 R-a 的扫描范围)`).toBe(true)
    }
    // 测试文件与文案目录是唯一的两类例外 —— 且排除必须**真的在做事**:
    // 未经过滤的整树集合里它们**存在**,过滤后的扫描集合里它们**不存在**
    // (只断言后者会是恒真式,等于没测)
    const unfiltered = collectSourceFiles(SRC_ROOT, SOURCE_EXTENSIONS).map((file) => file.path)
    expect(unfiltered.includes('src/shared/i18n/messages.ts')).toBe(true)
    expect(unfiltered.some((path) => isTestFile(path))).toBe(true)
    expect(paths.includes('src/shared/i18n/messages.ts')).toBe(false)
    expect(paths.some((path) => isTestFile(path))).toBe(false)
  })

  it('非渲染层(main + shared + preload)文案受约束:未登记的硬编码中文即失败,债务清单只减不增', () => {
    // 非渲染层的中文会经 IPC 信封 message / 状态事件 detail / 认证 message / 诊断 evidence /
    // zod 校验文案 / 端点解析错误文案到达界面(渲染层直接展示这些字段),所以必须纳入扫描 ——
    // 不能 blanket-exempt src/main 或 src/shared(四审 R-a:G1 证明 shared 此前是活的绕过口)。
    const files = collectScannedFiles().filter((file) => !isRendererPath(file.path))
    expect(files.length, '非渲染层应能遍历到源文件(否则这条护栏是空转)').toBeGreaterThan(20)
    // 四审 G1 的落点:shared 必须在集合内,否则「整树」不成立
    expect(
      files.some((file) => file.path === 'src/shared/endpoint.ts'),
      'src/shared 必须在非渲染层扫描集合内(四审 G1)'
    ).toBe(true)
    // 注意:**必须不带 ceiling 扫描**。此前把 NON_RENDERER_COPY_DEBT 当 ceiling 传进来,等于让扫描
    // 先把已登记的整行过滤掉,再拿过滤结果去比对同一份清单 —— 于是 `observed` 恒为空、
    // `stale` 恒等于整份清单(断言 `{unregistered:[], stale:[]}` 结构性不可满足)。
    // 现在:扫描给出「实际看到的站点」全集,再与清单做双向集合比对。
    // 五审 N1:站点身份是 (路径, 文案) —— 只比文本会让「把已登记的行搬进新文件」静默通过。
    const violations = scanSources(files, { logSinks: LOG_SINK_ENABLED })
    const { unregistered, stale } = diffDebt(violations, NON_RENDERER_COPY_DEBT)
    expect(
      { unregistered, stale },
      [
        '非渲染层出现未登记的硬编码中文文案，或债务清单已经过期:',
        formatViolations(violations),
        COPY_DEBT_HINT
      ].join('\n')
    ).toEqual({ unregistered: [], stale: [] })
    expect(new Set(NON_RENDERER_COPY_DEBT.map(([file, text]) => siteKey(file, text))).size, '债务清单里不应有重复站点').toBe(
      NON_RENDERER_COPY_DEBT.length
    )
    expect(
      NON_RENDERER_COPY_DEBT.length,
      '债务清单不应是空的(否则等于没有扫描非渲染层)'
    ).toBeGreaterThan(0)
  })

  it('非渲染层债务必须逐条归类:用户可见(a) ∪ 内部诊断(b) 恰好等于债务清单', () => {
    // 这条用例是「债务可行动」的机械保证:(b) 不是“先塞进去再说”的口袋 ——
    // 每条中文都得明确回答「会不会显示在界面上」,否则 (a)/(b) 的划分就是自说自话。
    const classified = [...NON_RENDERER_COPY_DEBT_USER_VISIBLE, ...NON_RENDERER_COPY_DEBT_INTERNAL]
    const classifiedSites = classified.map(([file, text]) => siteKey(file, text))
    const debtSites = NON_RENDERER_COPY_DEBT.map(([file, text]) => siteKey(file, text))
    expect(new Set(classifiedSites).size, '同一站点只能归一类:(a) 与 (b) 不得重叠').toBe(
      classifiedSites.length
    )
    expect([...classifiedSites].sort(), '有未归类的债务行(或清单被改坏)').toEqual(
      [...debtSites].sort()
    )
    expect(
      NON_RENDERER_COPY_DEBT_USER_VISIBLE.length,
      '(a) 用户可见待迁移清单不应为空'
    ).toBeGreaterThan(0)
    expect(NON_RENDERER_COPY_DEBT_INTERNAL.length, '(b) 内部诊断清单不应为空').toBeGreaterThan(0)
  })

  it('非渲染层债务身份含路径:把已登记的整行搬进新文件即 RED(五审 N1)', () => {
    // 五审 N1 的原始证明:此前按**行文本**集合比对(Set(text)),把一条**已登记**的行原样放进
    // **新文件** `src/main/r5-dup.ts` → 护栏 20/20 GREEN;而同一位置换成**新**文案则 RED。
    // 现在站点身份是 (路径, 文案),跨文件复制必然出新站点 → RED。
    const files = collectScannedFiles().filter((file) => !isRendererPath(file.path))
    const base = scanSources(files, { logSinks: LOG_SINK_ENABLED })
    // 底座:真实仓库当前双向都空(这条也保证下面的对照不是靠“本来就红”蒙对)
    expect(diffDebt(base, NON_RENDERER_COPY_DEBT)).toEqual({ unregistered: [], stale: [] })

    const registered = NON_RENDERER_COPY_DEBT_USER_VISIBLE.find(([, text]) =>
      text.includes("'端点地址不能为空'")
    )
    expect(registered, '这条已登记的端点文案必须还在清单里(否则本用例失去意义)').toBeDefined()
    const [registeredFile, registeredText] = registered ?? ['', '']
    expect(registeredFile, '已登记的站点应该钉在 shared/endpoint.ts').toBe('src/shared/endpoint.ts')

    // ① 同一条文本放进**新文件** → 必须 RED
    const duplicated = scanSources([{ path: 'src/main/zz-debt-dup.ts', text: `${registeredText}\n` }], {
      logSinks: LOG_SINK_ENABLED
    })
    expect(duplicated.map((violation) => violation.text), '同一条文本确实被扫到了').toEqual([
      registeredText
    ])
    expect(diffDebt([...base, ...duplicated], NON_RENDERER_COPY_DEBT), '搬进新文件必须报未登记').toEqual({
      unregistered: [`src/main/zz-debt-dup.ts :: ${registeredText}`],
      stale: []
    })

    // ② 已知残留缺口(诚实钉住):**同一个文件内**同文本的第 2 处站点折叠成同一个 (路径, 文案),
    //    因此不会被发现 —— 行号不进身份是刻意的(见清单头注释)。这条对照把边界写死在测试里。
    expect(
      diffDebt([...base, ...scanSources([{ path: registeredFile, text: `${registeredText}\n` }])], NON_RENDERER_COPY_DEBT),
      '同文件同文本不构成新站点(已知缺口,身份不含行号)'
    ).toEqual({ unregistered: [], stale: [] })

    // ③ 反向对照:真的有**新**文案时同样 RED(证明 diffDebt 不是恒绿)
    const novel = scanSources([{ path: registeredFile, text: "const x = '一条全新的界面文案'\n" }])
    expect(diffDebt([...base, ...novel], NON_RENDERER_COPY_DEBT).unregistered).toEqual([
      `src/shared/endpoint.ts :: const x = '一条全新的界面文案'`
    ])
  })

  it('主进程日志豁免只覆盖 console.* 的实参:同一行里的界面文案仍会失败', () => {
    const logged: SourceFile[] = [
      { path: 'src/main/demo.ts', text: "console.error('[demo] 日志文案:', error)\n" }
    ]
    // 同一份源码:开日志豁免=干净,关掉=违规 —— 证明豁免确实只由这条规则提供
    expect(scanSources(logged, { logSinks: true })).toEqual([])
    expect(scanSources(logged, { logSinks: false })).toHaveLength(1)

    // 四行**同一个文件**(行号才有意义):只有第 2 行是界面文案。
    // 此前这四行被写成 4 个同 path 的 SourceFile,每个都只有 1 行 —— 行号恒为 1,
    // 断言 `[2]` 与 scanSources 的契约(逐文件独立编号)矛盾,永远不可能通过。
    const mixed: SourceFile[] = [
      {
        path: 'src/main/demo.ts',
        text: [
          "console.error('[demo] 日志文案:', error)",
          "throw new Error('信封里的界面文案')",
          "console.error('[demo] 日志:', '这也是实参')",
          "const a = 1 console.error('日志') // 行尾注释里的中文",
          ''
        ].join('\n')
      }
    ]
    // 第 2 行才是界面文案:豁免不许扩散到同一行/同一文件的其它行,注释也不参与判定
    expect(scanSources(mixed, { logSinks: true }).map((violation) => violation.line)).toEqual([2])
    // 反向确认:关掉豁免后第 1、3、4 行的日志实参也会暴露(证明豁免确实在起作用)
    expect(scanSources(mixed, { logSinks: false }).map((violation) => violation.line)).toEqual([
      1, 2, 3, 4
    ])

    // 六审 R6-2:实参里的**正则**含未配对 `(` 时,区间不许延伸到文件尾。
    // 修复前 `logArgumentRegions` 只跳字符串不跳正则,`/\(/` 会把 depth 永久抬高 →
    // 该 `console.*` 之后**整个文件**的中文都被当成「只进日志」而豁免(实测 GREEN 漏报)。
    const withRegex: SourceFile[] = [
      {
        path: 'src/main/demo.ts',
        text: [
          "console.error('[demo] 日志:', /\\(/.test(raw))",
          "throw new Error('正则之后的界面文案')",
          ''
        ].join('\n')
      }
    ]
    const regexText = withRegex[0]?.text ?? ''
    // 区间必须止于该调用的右括号(= 第一行换行处),修复前会一路到 code.length
    expect(logArgumentRegions(regexText)).toEqual([[14, 43]])
    expect(regexText.length).toBeGreaterThan(43)
    // 行为断言:正则之后的下一行文案必须照报(修复前是空数组)
    expect(scanSources(withRegex, { logSinks: true }).map((violation) => violation.line)).toEqual([2])
  })

  it('模板字面量里的内容是文案(哪怕它长得像注释):askpass 债务行的根因', () => {
    // 复审追问「`/* 落到取消分支 */` 是注释,剥离器漏了它」的结论是:**不是剥离器的问题**。
    // 这一行在 src/main/ssh/askpass.ts 里位于 `ASKPASS_HELPER_SOURCE` 这个模板字面量**内部** ——
    // 在外层 TS 里它是字符串内容(生成脚本自己的注释),不是外层注释;剥离器按设计保留
    // 字符串/模板内容(与下面 c.ts `z//中文` 同一条规则),所以它必须被当作文案登记为债务。
    // 反过来说:任何“把模板里的注释也剥掉”的改法都会让模板里的真文案一起消失。
    const text = [
      'const S = `',
      '  } catch {',
      '    /* 落到取消分支 */',
      '  }',
      '` // 模板之后的真注释:中文不参与判定',
      ''
    ].join('\n')
    const violations = scanSources([{ path: 'src/main/askpass-like.ts', text }])
    // 只有模板内那一行算文案;模板**之后**的同款注释被正常剥离
    expect(violations.map((violation) => violation.line)).toEqual([3])
    expect(violations[0]?.text).toBe('/* 落到取消分支 */')
  })

  it('注释剥离是字符串感知的:字符串里的 `//` 不会吞掉后面的文案(复审 E4)', () => {
    const synthetic: SourceFile[] = [
      { path: 'a.ts', text: "const a = 'x//中文'\n" },
      { path: 'b.ts', text: 'const b = "y//中文"\n' },
      { path: 'c.ts', text: 'const c = `z//中文`\n' },
      { path: 'd.ts', text: "const d = 'it\\'s //中文'\n" },
      { path: 'e.ts', text: '// 纯注释:中文\nconst e = 1\n' },
      { path: 'f.ts', text: '/* 块注释:中文 */\nconst f = 1\n' },
      { path: 'g.tsx', text: 'const g = () => <div>{/* JSX 注释:中文 */}</div>\n' }
    ]
    expect(scanSources(synthetic).map((violation) => violation.path)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts'
    ])
  })

  it('注释剥离识别正则字面量:正则里的 `//` 不再吞掉后面的文案(四审 G3)', () => {
    // 四审 G3 的原始注入:靠正则里的 `\/\/` 把整行剩余部分抹成注释
    //   `const R4_URL_RE = /https?:\/\//; const R4_PROBE_LABEL = '打开网关登录页'`
    // 此前护栏 GREEN;对照组(同一行去掉正则)是 RED。下面每一条都是「必须看到该行的中文」。
    const synthetic: SourceFile[] = [
      // G3 原型
      { path: 'g3.ts', text: "const R = /https?:\\/\\//; const X = '打开网关登录页'\n" },
      // 字符类里含 `/`、转义斜杠、`/*`、引号(引号若被当字符串起点,后面的注释判定会歪)
      { path: 'cls.ts', text: "const A = /[/]\\/\\/x/; const B = '字符类里的文案'\n" },
      { path: 'quote.ts', text: "const C = /['\"\\/]\\//; const D = '正则里的引号与斜杠'\n" },
      { path: 'block.ts', text: "const E = /\\/\\*不是块注释/; const F = '正则里的 /* '\n" },
      // 反向:真除号仍判除号,行尾/块注释照常剥离(对照组 A 的性质)
      { path: 'div.ts', text: "const G = a / b // 真注释里的中文\nconst H = '除号之后的文案'\n" },
      {
        path: 'div2.ts',
        text: "const I = (a + b) / 2 /* 块注释里的中文 */\nconst J = '除号块注释之后的文案'\n"
      },
      {
        path: 'div3.ts',
        text: "let k = 0\nk++ / 2 // 自增之后仍是除号:这行注释必须被剥离\nconst M = '自增之后的文案'\n"
      },
      // 正则之后的真注释照样剥离(不会被当成“正则的一部分”留着)
      {
        path: 'after.ts',
        text: "const N = /x/g // 行尾注释里的中文\nconst O = '正则行尾注释之后的文案'\n"
      }
    ]
    expect(
      scanSources(synthetic).map((violation) => `${violation.path}:${violation.line}`)
    ).toEqual([
      'g3.ts:1',
      'cls.ts:1',
      'quote.ts:1',
      'block.ts:1',
      'div.ts:2',
      'div2.ts:2',
      'div3.ts:3',
      'after.ts:2'
    ])
    // 对照 A:同一行去掉正则 → 同样 RED(证明扫描器确实覆盖这些行,不是恒绿)
    expect(
      scanSources([
        { path: 'control.ts', text: "const R4_CONTROL = '控制组硬编码文案（无正则遮蔽）'\n" }
      ]).map((violation) => `${violation.path}:${violation.line}`)
    ).toEqual(['control.ts:1'])
  })

  it('注释剥离识别**语句位置**的正则字面量:`)`/`}` 之后的正则不再吞掉整行文案(五审 E1–E3)', () => {
    // 五审 R-b 的原始注入:`)`/`]`/`}` 一律被当「值之后」→ 语句位置的真正则被当除号,
    // 其内的第二个 `/` 与后一个 `/` 凑成 `//`,于是**整行剩余部分(含中文文案)被抹成空格**。
    // 下面每一条修复前都是 GREEN(漏报),现在每条都必须报出该行的中文。
    const synthetic: SourceFile[] = [
      // E1:控制语句的 `)` 之后 —— `while` / `for (;;)` 同形
      { path: 'e1-if.ts', text: "if (ok) /a\\//.test(s); const C = '文案E1'\n" },
      { path: 'e1-while.ts', text: "while (ok) /a\\//.test(s); const C = '文案E1b'\n" },
      { path: 'e1-for.ts', text: "for (;;) /a\\//.test(s); const C = '文案E1c'\n" },
      // E1(六审 R6-1):`for await (` 的 `(` 紧随 `await`,`for` 被挡住 —— 必须同样按控制括号登记
      {
        path: 'e1-for-await.ts',
        text: "for await (const it of xs) /a\\//.test(it); const C = '文案E1d'\n"
      },
      // 反向对照 4:裸 `await (` 前面**没有** `for`,仍是普通括号 → `/` 是除号,该行文案必须照报
      // (若过度修复成「`await (` 也是控制括号」,`/` 会被当正则起点吞掉整行 → 此用例转 RED)
      {
        path: 'await-paren-div.ts',
        text: "const z = await (a + b) / 2 + '除号之后的文案E1e'\n"
      },
      // E2:块语句的 `}` 之后 —— `if (…){}` / `function f(){}` / `class X{}` 三种形态
      { path: 'e2-block.ts', text: "if (ok) { f() } /a\\//.test(s); const C = '文案E2'\n" },
      { path: 'e2-fn.ts', text: "function f() {} /a\\//.test(s); const C = '文案E2b'\n" },
      { path: 'e2-fn-ret.ts', text: "function f(): void {} /a\\//.test(s); const C = '文案E2c'\n" },
      { path: 'e2-class.ts', text: "class X {} /a\\//.test(s); const C = '文案E2d'\n" },
      // E3:`/*` 形态同样不能吞到行尾
      { path: 'e3.ts', text: "if (ok) /a\\/*/.test(s); const C = '文案E3'\n" },
      // 反向对照 1:块语句的 `}` 之后确实是**真注释**时照常剥离(不能反过来把注释留着)
      {
        path: 'block-comment.ts',
        text: "if (ok) { f() } // 这里的行尾注释必须剥离\nconst C = '块后真注释之后的文案'\n"
      },
      // 反向对照 2:**对象字面量**的 `}` 之后仍是除号(不能把「块语句」规则乱套到对象上)
      {
        path: 'object-div.ts',
        text: "const x = { a: 1 } / 2\nconst K = '对象字面量之后的文案'\n"
      },
      // 反向对照 3:普通括号的 `)` 之后仍是除号(控制语句的括号才改判)
      {
        path: 'paren-div.ts',
        text: "const y = (a + b) / 2\nconst L = '普通括号之后的文案'\n"
      }
    ]
    expect(scanSources(synthetic).map((violation) => `${violation.path}:${violation.line}`)).toEqual([
      'e1-if.ts:1',
      'e1-while.ts:1',
      'e1-for.ts:1',
      'e1-for-await.ts:1',
      'await-paren-div.ts:1',
      'e2-block.ts:1',
      'e2-fn.ts:1',
      'e2-fn-ret.ts:1',
      'e2-class.ts:1',
      'e3.ts:1',
      'block-comment.ts:2',
      'object-div.ts:2',
      'paren-div.ts:2'
    ])
  })

  it('JSX/HTML 文本节点按文本保留:文本里的 `//` `/*` `https://` 不再被当注释(五审 J1/J2/J3/J5)', () => {
    // 五审 R-b 的第二条家族:JSX/HTML **文本节点没有模式** —— `<p>//中文</p>` 里的 `//` 被当行注释,
    // `<p>/*中文*/</p>` 被当块注释,`<p>https://例子.中国</p>` 的域名被吞。三者都是**真上屏文案**。
    expect(modeForPath('a.ts')).toBe('code')
    expect(modeForPath('a.tsx')).toBe('jsx')
    expect(modeForPath('a.html')).toBe('html')
    expect(modeForPath('a.css')).toBe('code')

    const synthetic: SourceFile[] = [
      { path: 'j1.tsx', text: 'const A = () => <p>//中文文案J1</p>\n' },
      { path: 'j2.tsx', text: 'const B = () => <p>/*中文文案J2*/</p>\n' },
      { path: 'j3.tsx', text: 'const C = () => <p>https://例子.中国</p>\n' },
      { path: 'j4.tsx', text: 'const D = () => <span>纯文本节点里的文案</span>\n' },
      { path: 'j5a.html', text: '<p>//中文文案J5a</p>\n' },
      { path: 'j5b.html', text: '<p>/*中文文案J5b*/</p>\n' },
      { path: 'j5c.html', text: '<p>https://例子.中国</p>\n' },
      { path: 'j5d.html', text: '<!doctype html>\n<html>\n  <head>\n    <title>数据目录控制台</title>\n  </head>\n</html>\n' },
      // 反向对照 1:JSX 注释仍是注释(AuthPanel.tsx 里真实存在的形态),不许报
      { path: 'ok-comment.tsx', text: 'const g = () => <div>{/* JSX 注释:中文 */}</div>\n' },
      // 反向对照 2:JSX **属性之间**的 `//` 注释仍是注释(Attributes 里的真实写法),不许报
      {
        path: 'ok-attr-comment.tsx',
        text: [
          'const m = () => (',
          '  <button',
          '    onClick={() => void submit()}',
          '    // D5:属性之间的注释:中文',
          '    disabled={x}',
          '  >',
          "    {t('a')}",
          '  </button>',
          ')',
          ''
        ].join('\n')
      },
      // 反向对照 3:HTML 注释与 `<script>` 正文(按代码处理)里的中文,不许报
      {
        path: 'ok-html.html',
        text: [
          '<!doctype html>',
          '<title>DSH Hub</title>',
          '<!-- 注释里的中文 -->',
          '<script>',
          '  // 脚本注释里的中文',
          '  const a = 1',
          '</script>',
          ''
        ].join('\n')
      }
    ]
    expect(scanSources(synthetic).map((violation) => `${violation.path}:${violation.line}`)).toEqual([
      'j1.tsx:1',
      'j2.tsx:1',
      'j3.tsx:1',
      'j4.tsx:1',
      'j5a.html:1',
      'j5b.html:1',
      'j5c.html:1',
      'j5d.html:4'
    ])
  })

  it('注释剥离在畸形输入上仍然终止:未闭合的块注释 / HTML 注释 / 字符串都不会死循环', () => {
    // 本文件曾因「循环不推进」把整个测试套件挂死(SIGTERM 且无任何输出)。这里把每条能走到的
    // 「找不到结束标记」的路径都钉住:可以保守(不抹),但**必须前进**。
    const malformed: SourceFile[] = [
      { path: 'open-block.ts', text: "/* 未闭合的块注释:中文\nconst a = 1\nconst b = '后续文案'\n" },
      { path: 'open-html.html', text: '<!-- 未闭合的注释中文\n<p>after</p>\n' },
      { path: 'open-string.ts', text: "const s = '未闭合字符串\nconst t = '第二条'\n" },
      { path: 'open-regex.ts', text: 'const r = /未闭合的正则\nconst u = 1\n' },
      { path: 'open-template.ts', text: 'const v = `未闭合的模板\n' },
      { path: 'open-script.html', text: '<script>\nconst w = 1\n' },
      { path: 'open-jsx.tsx', text: 'const x = () => <p>未闭合的 JSX\n' }
    ]
    // 只要它能返回(不挂死),就说明每条分支都在推进;顺带钉住行号没有越界
    for (const file of malformed) {
      const violations = scanSources([file])
      for (const violation of violations) {
        expect(violation.line, `${file.path} 的行号必须落在文件内`).toBeGreaterThanOrEqual(1)
        expect(violation.line).toBeLessThanOrEqual(file.text.split('\n').length)
      }
    }
    // 未闭合的块注释按设计一直抹到文件尾(没有结束标记就不猜内容边界),后续文案因此不可见;
    // 未闭合的 HTML 注释反过来**不抹**(保留为文本)→ 中文多报。两个方向都写死在用例里。
    expect(
      scanSources([{ path: 'a.ts', text: '/* 未闭合:中文\n' }]).map((v) => v.line),
      '未闭合块注释:没有结束标记 → 抹到文件尾(这条是刻意的保守选择)'
    ).toEqual([])
    expect(
      scanSources([{ path: 'b.html', text: '<!-- 未闭合:中文\n' }]).map((v) => v.line),
      '未闭合 HTML 注释:不猜 → 保留为文本 → 多报'
    ).toEqual([1])
  })

  it('模板的 `${...}` 按代码处理:嵌套模板里的注释被剥离、外层模板文案仍保留', () => {
    // 此前实现会在内层反引号处提前闭合外层模板,于是 `${}` 里的引号/注释判定会歪
    const text = [
      'const S = `${a ? `x${b /* 嵌套模板表达式里的注释 */}` : "y"}`',
      "const T = '嵌套模板旁边的文案'"
    ].join('\n')
    const violations = scanSources([{ path: 'src/main/nested.ts', text }])
    expect(violations.map((violation) => violation.line)).toEqual([2])
  })

  it('注释剥离保持行号:块注释与字符串里的换行都不许吃掉行号(复审 E10)', () => {
    // 真实行 36 就是违规行 —— 此前版本把块注释里的换行删掉,报出来的行号整体上移
    const padding = Array.from(
      { length: 30 },
      (_value, index) => `const v${index} = ${index}`
    ).join('\n')
    const text = [
      padding,
      '/* 块注释',
      '   跨了多行',
      '   也必须保留换行 */',
      'const tpl = `multi',
      '   line ${1 + 1} text`',
      "const last = '中文文案'"
    ].join('\n')
    const violations = scanSources([{ path: 'src/renderer/src/x.ts', text }])
    expect(violations).toHaveLength(1)
    expect(violations[0]?.line).toBe(36)
  })

  it('\\uXXXX 转义写法的中文同样被检出(复审 E6)', () => {
    const synthetic: SourceFile[] = [
      { path: 'esc.ts', text: "const a = '\\u786c\\u4e2d\\u6587'\n" },
      { path: 'braced.ts', text: "const b = '\\u{4e2d}\\u{6587}'\n" },
      { path: 'latin.ts', text: "const c = '\\u0041\\u0062'\n" }
    ]
    expect(scanSources(synthetic).map((violation) => violation.path)).toEqual([
      'esc.ts',
      'braced.ts'
    ])
  })

  it('MIGRATED 清单被钉住:不能靠删条目缩小护栏范围(复审 S11b)', () => {
    expect([...MIGRATED].sort()).toEqual([...MIGRATED_PIN].sort())
    for (const name of MIGRATED) {
      expect(existsSync(migratedPath(name)), `${name} 已不在磁盘上,请修正 MIGRATED 清单`).toBe(true)
    }
  })

  it('PENDING 被钉住且为空:新增豁免必须有意修改钉值(复审 E5)', () => {
    expect([...PENDING]).toEqual([...PENDING_PIN])
    // 当前为空:任何“先放过一个文件”的登记都要同时改 PENDING_PIN 并在旁边写明理由
    expect(PENDING).toEqual([])
    for (const path of PENDING) {
      expect(existsSync(join(process.cwd(), path)), `${path} 已不在磁盘上,请从 PENDING 移除`).toBe(
        true
      )
    }
  })

  it('豁免面被钉住:只有语言选择器那一行与 console.* 实参两条出口(复审 E5/E8)', () => {
    expect(ALLOWED_LITERALS).toHaveLength(1)
    expect(NON_RENDERER_EXEMPTIONS.map((entry) => entry.kind)).toEqual(['console-args'])
    // 删掉这条规则会让主进程日志集体违规,所以它不可能被悄悄关掉而不被发现
    expect(LOG_SINK_ENABLED).toBe(true)
  })

  it('排除面被钉住:唯一被排除的是文案目录本身,增删必须有意改钉值(四审 R-a)', () => {
    expect([...SOURCE_EXCLUSIONS]).toEqual([...SOURCE_EXCLUSIONS_PIN])
    expect(SOURCE_EXCLUSIONS, '排除面只允许文案目录这一条(新增排除=新增暗门)').toEqual([
      'src/shared/i18n/messages.ts'
    ])
    for (const path of SOURCE_EXCLUSIONS) {
      expect(existsSync(join(process.cwd(), path)), `${path} 已不在磁盘上,请修正排除面`).toBe(true)
    }
  })

  it('文案目录覆盖设置页与托盘所需的键(缺键会在运行时显示 key)', () => {
    const required = [
      'settings.title',
      'settings.language',
      'settings.theme',
      'settings.tray',
      'settings.autoStart',
      'settings.notifications',
      'settings.dataDir',
      'settings.clearCredentials',
      'settings.saved',
      'tray.show',
      'tray.quit',
      'tray.status'
    ]
    const missing = required.filter((key) => !MESSAGE_KEYS.includes(key as never))
    expect(missing).toEqual([])
  })

  it('主线使用的 key 确实存在于文案目录(缺键会在界面显示原始 key)', () => {
    // 只做「目录 → 存在性」方向:反向的「死键」检测需要扫描全部源码字符串，
    // 当前以人工清理为主(复审 R6 已清掉 settings.openDataDir)。
    const required = [
      'settings.saveFailed',
      'settings.cleared',
      'notify.connected',
      'notify.error',
      'detail.openViewFailed',
      'tray.show',
      'tray.quit',
      'tray.status'
    ]
    const missing = required.filter((key) => !MESSAGE_KEYS.includes(key as never))
    expect(missing).toEqual([])
  })

  it('托盘状态行的插值参数两种语言都有', () => {
    expect(MESSAGES['tray.status'].zh).toContain('{count}')
    expect(MESSAGES['tray.status'].en).toContain('{count}')
  })
})
