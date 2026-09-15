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
 * i18n 走查护栏（T11）—— 第三轮加固：把「默认受约束」写死成规则。
 *
 * 1. **扫描范围 = 目录遍历的结果，不是人工登记的清单**。渲染层 `src/renderer/**` 的
 *    `.ts/.tsx/.css`（含嵌套子目录、含 CSS 伪元素里的文案），主进程 `src/main/**` 的 `.ts`。
 *    新加一个文件即自动受约束 —— 没人“记得登记”也不会漏（复审 E3）。
 * 2. **判定单位是行**：注释（`//`、块注释、JSX 注释）不参与判定；剥离注释时**跳过字符串与
 *    模板字面量**，所以 `'a//中文'` 里的 `//` 不会把文案吞掉，且**行号与真实文件一致**（E4/E10）。
 *    推论:模板字面量里的内容是**文案**(模板内容不剥离),哪怕它长得像注释 —— 例如
 *    `ASKPASS_HELPER_SOURCE` 里那行只写着「落到取消分支」的块注释是生成脚本的注释,在外层 TS
 *    里它只是字符串内容,所以必须被登记为债务,而不是靠“更聪明的注释剥离”抹掉(见下方用例)。
 * 3. **两种写法都算中文**：字面字符，以及 `\uXXXX` / `\u{XXXX}` 转义（E6）。
 * 4. **豁免只有三条出口，且全部被钉住**：① 语言选择器那一行；② 主进程 `console.*` 的实参
 *    （只进日志，不是用户可见文案，理由写在 MAIN_EXEMPTIONS 里）；③ 已登记的主进程债务行。
 *    任何清单/钉值的增删都必须**有意修改本文件**，否则测试失败（E5：PENDING 曾被随意扩大）。
 *    注意 ③ 是「对**扫描全集**做集合比对」而不是「扫描时过滤掉已登记的行」:后者会让
 *    “有没有新增 / 有没有过期”两个方向同时失效(见 scanSources 的注释)。
 * 5. 纯扫描核心与文件系统解耦（scanSources 吃 `{path,text}[]`），所以“这些绕过方式必须被抓住”
 *    的用例全部用合成源码验证，不写真实目录。
 * 6. 主进程债务分两档登记:**(a) 用户可见、待做 code→文案迁移**（本护栏存在的理由）、
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
 * 去掉注释，且**跳过字符串/模板字面量**（含转义）：
 * - 行注释与块注释都替换成等长空格（块注释保留其中的换行），因此**行号与列号都不变**；
 * - 字符串/模板字面量原样搬运 —— 里面的 `//` 或 `/*` 不是注释（复审 E4）。
 *
 * 已知边界：模板字面量里嵌套的模板（``` `${a ? `b` : 'c'}` ```）会提前闭合外层字面量，
 * 于是 ${...} 内部的引号可能被当成代码解析；本仓库现有代码不受影响，且判定/登记用的是
 * 同一份实现（见 MAIN_COPY_DEBT 由扫描结果生成），所以不会自相矛盾。
 */
export function stripComments(source: string): string {
  let out = ''
  let index = 0
  const length = source.length
  while (index < length) {
    const char = charAt(source, index)
    const next = charAt(source, index + 1)
    if (char === '/' && next === '/') {
      while (index < length && charAt(source, index) !== '\n') {
        out += ' '
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      while (
        index < length &&
        !(charAt(source, index) === '*' && charAt(source, index + 1) === '/')
      ) {
        out += charAt(source, index) === '\n' ? '\n' : ' '
        index += 1
      }
      out += '  '
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      out += char
      index += 1
      while (index < length) {
        const inner = charAt(source, index)
        if (inner === '\\') {
          const escaped = charAt(source, index + 1)
          out += inner
          // 转义后的换行要按换行处理（否则行号会漂）
          out += escaped === '\n' ? '\n' : escaped
          index += 2
          continue
        }
        out += inner
        index += 1
        if (inner === quote) break
      }
      continue
    }
    out += char
    index += 1
  }
  return out
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
export function logArgumentRegions(code: string): Array<readonly [number, number]> {
  const regions: Array<readonly [number, number]> = []
  const pattern = /\bconsole\s*\.\s*(?:log|info|warn|error|debug|trace)\s*\(/g
  let match = pattern.exec(code)
  while (match !== null) {
    let index = match.index + match[0].length
    let depth = 1
    while (index < code.length && depth > 0) {
      const char = charAt(code, index)
      const quote = char === '"' || char === "'" || char === '`' ? char : null
      if (quote !== null) {
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
        continue
      }
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
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
    const code = stripComments(file.text)
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

const RENDERER_ROOT = join(process.cwd(), 'src/renderer')
const RENDERER_SRC = join(RENDERER_ROOT, 'src')
const COMPONENTS_DIR = join(RENDERER_SRC, 'components')
const MAIN_ROOT = join(process.cwd(), 'src/main')
/** 渲染层:含 .css —— CSS-in-JS / 伪元素里的文案也是界面文案 */
const RENDERER_EXTENSIONS = ['.ts', '.tsx', '.css'] as const
const MAIN_EXTENSIONS = ['.ts'] as const

/** 测试文件不参与判定:里面的中文是测试名与断言数据,不是界面文案,也不进打包产物 */
const isTestFile = (path: string): boolean => /\.test\.tsx?$/.test(path)

/**
 * 允许保留的字面量:语言选择器按惯例用**该语言自身**书写（「中文」/English），
 * 翻译它反而会让用户找不到自己的语言。逐行精确匹配，只作用于这一行。
 */
const ALLOWED_LITERALS: readonly RegExp[] = [/^\{?language === 'zh' \? '中文' : 'English'\}?$/]

/**
 * 主进程显式豁免表。每条都必须写清「为什么它不可能是用户可见文案」——
 * 这是主进程唯一被允许的“规则型”出口，不允许再出现别的整体豁免（禁止 blanket-exempt src/main）。
 */
const MAIN_EXEMPTIONS = [
  {
    id: 'main-console-log',
    kind: 'console-args',
    levels: ['log', 'info', 'warn', 'error', 'debug', 'trace'],
    // 为什么不是用户可见文案:console.* 的实参只写进 Electron 主进程的 stdout/stderr
    // （终端 / 日志文件），不经过任何 IPC 通道，渲染层也拿不到 —— 界面上永远看不到。
    // 只豁免**实参区间内**的文案:同一行里若还有别的中文字面量（比如拼给 IPC 信封的 message），
    // 仍然判违规。
    reason: '主进程日志:只进终端/日志文件，不进入任何 UI 通道'
  }
] as const

const LOG_SINK_ENABLED = MAIN_EXEMPTIONS.some((entry) => entry.kind === 'console-args')

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
 */
const MIGRATED_PIN: readonly string[] = [...MIGRATED]

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
 * 主进程硬编码文案债务清单 —— 分两类登记,**只减不增**。
 *
 * (a) MAIN_COPY_DEBT_USER_VISIBLE = **用户可见、待迁移**的部分。
 *     这些中文会随主进程字段直接显示在界面上(渲染层不翻译这些字段,原样渲染):
 *     IPC 信封 `message` → toast(`result.message`);状态事件 `detail` → App.tsx / DetailView 的
 *     实例状态行;认证状态 `message` → AuthPanel 的 auth-message;探测 `evidence` → UrlDetect;
 *     口令提示语 → SshDialogs 的 askpass 弹窗副标题;指纹值 → 指纹确认弹窗。
 *     迁移方式(PRD §8):主进程只发稳定 code,渲染层按 code 映射到 @shared/i18n/messages.ts。
 *     该迁移要动认证 wire 契约,尚未执行 —— 这些条目是本护栏存在的理由,不是“已确认无碍”。
 *     清单里的行按**到达界面的渠道**分组,便于按通道批量迁移。
 *
 * (b) MAIN_COPY_DEBT_INTERNAL = **内部诊断**,逐条写明“为什么不可能出现在界面上”。
 *     注意 (b) 不是“允许新增”的口袋:任何新中文都得先归到 (a)/(b) 之一(下面用例强制分档),
 *     而 (b) 的每一条都必须能指着代码说明它不经过 UI。
 *
 * 两层钉值:MAIN_COPY_DEBT 必须与扫描到的集合**完全相等**(多一条=未登记新增,少一条=已迁移却忘删),
 * 且 (a) ∪ (b) 必须恰好等于它。删条目时请把文案搬进 @shared/i18n/messages.ts 后一起改。
 */
const MAIN_COPY_DEBT_USER_VISIBLE: readonly string[] = [
  // —— IPC 信封 message（渲染层 toast 直接展示 result.message） ——
  ".refine((v) => v === null || v.trim() !== '', '口令不能为空串')",
  "if (!current) throw new InstanceStoreError('not-found', `实例不存在：${id}`)",
  "if (!deps.openDataDir) throw new DataDirOpenError('internal', '打开数据目录不可用')",
  "if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)",
  "if (dir === '') throw new DataDirOpenError('internal', '数据目录不可用')",
  "return new InstanceStoreError('io-error', `注册表 IO 失败：${message}`)",
  "return { ok: false, code: 'internal', message: '内部错误，请查看主进程日志' }",
  "throw new InstanceStoreError('invalid-input', '只有 SSH 隧道实例才有主机指纹')",
  "throw new InstanceStoreError('invalid-input', '未知的传输类型')",
  "throw new InstanceStoreError('invalid-input', `字段 ${key} 不适用于 ${current.transport} 实例`)",
  "throw new InstanceStoreError('invalid-state', '实例尚未运行，无法打开视图')",
  "throw new InstanceStoreError('not-found', `实例不存在：${parsed.instanceId}`)",

  // —— 状态事件 detail（App.tsx / DetailView 的实例状态行） ——
  ": '分配端口并启动进程（端口区间不可用，改由 dsh 自动选择）'",
  ": '按配置使用网关登录（T7 接入）'",
  "? '按配置跳过登录认证'",
  '? `分配端口并启动进程（端口 ${preferredPort}）`',
  "`安装 ${DSH_PACKAGE_NAME}@${version} 失败（exit ${result.code}）：${result.stderr.trim() || '无 stderr'}`",
  "detail: '实例已在运行，忽略重复启动'",
  "detail: '隧道已在运行，忽略重复启动'",
  'detail: `SSH 隧道已就绪（127.0.0.1:${entry.localPort} → ${entry.remoteLabel}）`',
  'detail: `SSH 隧道断开（${attribution.message}）；${entry.backoffMs / 1000}s 后自动重连`',
  'detail: `准备 dsh ${version} 运行时（首次需要安装，可能较慢）`',
  "detail: `启动超时（${Math.round(readyTimeoutMs / 1000)}s）：未解析到就绪 URL${entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''}`",
  'detail: `安装 ${DSH_PACKAGE_NAME}@${version}`',
  'detail: `就绪 URL 无法访问（健康探测 ${healthProbeRetries} 次失败）：${url}`,',
  'detail: `已在 ${entry.home} 启动（dsh web）`',
  'detail: `建立 SSH 隧道（${localPort} → ${entry.remoteLabel}）`',
  "detail: `进程意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）${entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''}`",
  "emit(entry.id, 'error', { detail: '远端 dsh 未就绪（就绪探测超时），即将自动重连' })",
  "emit(entry.id, 'starting', { detail: '等待输入 SSH 口令（不落盘）' })",
  "emit(entry.id, 'starting', { detail: `本地端口已重新分配为 ${port}` })",
  "emit(entry.id, 'starting', { detail: `第 ${entry.reconnectCount} 次自动重连（${entry.url}）` })",
  "emit(entry.id, 'stopped', { detail: '实例已删除' })",
  "emit(id, 'error', { detail: '服务器指纹未确认（或已变化），已拒绝连接' })",
  "emit(id, 'error', { detail: `SSH 进程启动失败：${error.message}` })",
  "emit(id, 'error', { detail: `端点不可达：${url}（连接被拒或超时）`, url })",
  "emit(id, 'error', { detail: `进程启动失败：${error.message}` })",
  "emit(id, 'running', { url: existing.url, detail: '实例已在运行，忽略重复启动' })",
  "emit(id, 'starting', { detail: '分配本地端口' })",
  "emit(id, 'starting', { detail: '口令输入通道不可用，将尝试非交互认证（agent / 免密密钥）' })",
  "emit(id, 'starting', { detail: '校验服务器指纹' })",
  "emit(id, 'starting', { detail: '检测到隧道已中断，重新建立连接' })",
  "emit(id, 'starting', { detail: '解析运行时版本' })",
  "emit(id, 'starting', { detail: '隧道正在启动，忽略重复启动' })",
  "emit(id, 'starting', { detail: `校验端点 ${url}` })",
  "emit(id, 'starting', { url, detail: '探测认证模式' })",
  "emit(id, 'stopped', { detail: '实例未在运行' })",
  "emit(id, 'stopped', { detail: '已停止' })",
  "emit(id, 'stopped', { detail: '已取消启动' })",
  "emit(id, 'stopped', { detail: '隧道已停止' })",
  "emit(id, 'stopped', { detail: exited ? '已停止' : '已强制停止（SIGKILL）' })",
  "emitWaiting('服务器指纹已变化，已拒绝连接')",
  "emitWaiting('等待确认服务器指纹')",
  "entry.pendingReason = { kind: 'connect', message: '远端 dsh 未就绪' }",
  "if (secret !== null) emit(entry.id, 'starting', { detail: '已收到口令，继续建立隧道' })",
  "if (versions.length === 0) throw new Error('registry 中没有可用的 dsh 版本')",
  "label: '主机名解析失败'",
  "label: '服务器指纹未确认或被更改（请在实例详情重新确认指纹）'",
  "label: '端口转发失败（本地端口被占或远端拒绝监听）'",
  "label: '连接被拒绝或中断'",
  "label: '连接被远端关闭'",
  "label: '连接超时'",
  "label: '鉴权失败（口令 / 密钥 / 权限）'",
  "message: `${feature.label}${detail ? `（${detail}）` : ''}`",
  "message: `SSH 会话异常退出（code=${code ?? 'null'}）` + (evidence ? `；${evidence}` : '')",
  "return '无需登录认证，可直接访问'",
  "return '检测到 dsh 内置浏览器认证（页面内自认证）'",
  'return `检测到登录认证（${detection.evidence}）`',
  "return { kind: 'closed', message: 'SSH 进程正常退出（退出码 0）' }",
  'throw new Error(`端口段 ${start}-${end} 内没有可用端口`)',
  'throw new Error(`读取可用版本失败：${result.stderr.trim() || `exit ${result.code}`}`)',
  'throw new Error(`非法版本号：${version}`)',

  // —— 认证状态 message（AuthPanel 的 auth-message） ——
  "'invalid-backup-code': '备份码无效',",
  "'invalid-credentials': '账号或验证码错误',",
  "'invalid-otp': '动态验证码错误',",
  "'onboarding-required': '需要先设置新的登录密码',",
  "'otp-not-enabled': '该实例未启用动态验证码',",
  "'otp-required': '请输入动态验证码或备份码',",
  "'otp-secret-missing': '实例的 OTP 配置异常，请联系管理员'",
  "'password-mismatch': '两次输入的密码不一致',",
  "'password-too-short': '密码太短',",
  "'password-too-simple': '密码强度不足',",
  "'payload-too-large': '请求体过大',",
  "'rate-limited': '尝试过于频繁，请稍后再试',",
  "'too-many-attempts': '失败次数过多，账号已临时锁定',",
  "message: '登录成功响应缺少会话 Cookie',",
  "message: '该实例需要先设置新的登录密码'",
  "message: '账号或验证码错误'",
  "message: error instanceof Error ? `网络错误：${error.message}` : '网络错误',",
  "message: rawMessage !== '' ? rawMessage : messageFor(code, `请求失败（HTTP ${status}）`),",
  "unauthenticated: '登录状态已失效，请重新登录',",

  // —— 探测 evidence（UrlDetect 直接展示 detection.evidence） ——
  "evidence: '401 + dsh 内置 BrowserAuth 提示（webview 自认证）',",
  "evidence: '401（无识别特征）',",
  "evidence: `${status} → ${location || '(无 Location)'}（未识别的重定向）`,",
  'evidence: `${status} → ${location}（网关 onboarding 未完成）`,',
  'evidence: `${status} → ${location}（网关登录页重定向）`,',
  'evidence: `${status} → ${location}（网关要求二因素验证）`,',
  'evidence: `${status} 可直接访问（无需登录）`,',
  "evidence: `401 JSON${error ? ` error=${error}` : ''}（网关 API 直探）`,",
  'evidence: `连接失败：${message}`,',

  // —— askpass 提示语（口令弹窗副标题 SshDialogs.tsx:203 直接渲染 prompt） ——
  //    第 1 条在生成脚本里：ssh 正常都会把提示语作为 argv[2] 传进来，这条只是兜底；
  //    一旦命中，它会被脚本原样发给主进程并显示在弹窗里（与第 2 条主进程兜底同一句文案）。
  "const prompt = process.argv[2] || 'SSH 需要输入口令'",
  "let prompt = 'SSH 需要输入口令'",

  // —— 指纹展示值（指纹确认弹窗） ——
  "return 'SHA256:<无法解析>'",
]

/**
 * (b) 内部诊断:中文只进日志 / 被吞掉 / 当前无消费者,渲染层拿不到这些字段。
 * 每条的理由见所属分组的小标题。
 */
const MAIN_COPY_DEBT_INTERNAL: readonly string[] = [
  // —— askpass helper 脚本内容（写盘后由 ssh 子进程执行，脚本正文从不渲染）：脚本头注释、
  //    catch 分支注释、三处 stderr 日志，以及包装脚本 askpass.sh 里的 shell 注释 ——
  "'# 由 DSH Hub 运行时写入：用自带 Node 执行 askpass helper（不依赖 PATH 中的 node）',",
  '/* 落到取消分支 */',
  'export const ASKPASS_HELPER_SOURCE = `// 由 DSH Hub 运行时写入；把 ssh 的口令提示转发给主进程，答案只经 stdout 回给 ssh。',
  "process.stderr.write('askpass: DSH_HUB_ASKPASS_SOCKET 未设置\\\\n')",
  "process.stderr.write('askpass: 等待用户输入超时\\\\n')",
  "process.stderr.write('askpass: 通道失败 ' + error.message + '\\\\n')",

  // —— 注册表损坏隔离原因:只进 console.warn 与隔离文件名,不进任何 IPC/状态字段 ——
  "await quarantineCorruptFile('JSON 解析失败')",
  'await quarantineCorruptFile(`schema 校验失败：${reason}`)',
  'await quarantineCorruptFile(`schemaVersion=${from} 高于当前 ${REGISTRY_SCHEMA_VERSION}，拒绝降级`)',
  'await quarantineCorruptFile(`缺少 schemaVersion ${v} → ${v + 1} 的迁移器`)',

  // —— 普通 Error(message 为中文):IPC 边界统一换成稳定码的固定文案(register.ts wrap 的 internal),明细只进主进程日志;或被调用方 catch 后只 console.error ——
  "else reject(error ?? new Error('ssh -G 未返回任何配置'))",
  "if (password === '') throw new Error('空密码不写入 vault')",
  "if (session.value === '') throw new Error('空会话不写入 vault')",
  'throw new Error(`未勾选「${field}」,拒绝写入 vault`)',

  // —— vault 的 onError 回调:缺省实现是 console.error('[vault] 操作失败：', error),只进日志 ——
  "onError(new Error('vault 会话载荷不是合法 JSON,已丢弃'))",
  "onError(new Error('vault 文件格式不符,已忽略'))",

  // —— ssh-keyscan 失败被 ensureTrust 的 catch {} 吞掉(不判 TOFU、不显示),交给 ssh 自己连接并归因 ——
  "else reject(error ?? new Error('ssh-keyscan 未返回任何公钥'))",

  // —— 工厂参数断言(调用方传常量):纯程序员错误,不会出现在界面上 ——
  "if (!Number.isInteger(limit) || limit < 1) throw new Error('并发上限必须是正整数')",

  // —— 当前**没有任何消费者**:backoff 的 reason 只写不读;auth-client 的 evidence 被两处 probe 调用方丢弃(register.ts:344 / index.ts:630),session-restored 分支 message 置 null ——
  "evidence: '已存会话有效（静默恢复）',",
  "reason = why ?? '请求过于频繁，已暂停自动重试'",
]

/**
 * 两份清单的并集:(a) 用户可见待迁移 + (b) 内部诊断。
 * 当前 (a) 103 条 / (b) 20 条 —— 下面「主进程文案受约束」用例把它与扫描结果钉成等号。
 */
const MAIN_COPY_DEBT: readonly string[] = [
  ...MAIN_COPY_DEBT_USER_VISIBLE,
  ...MAIN_COPY_DEBT_INTERNAL
]

// ───────────────────────── 用例 ─────────────────────────

const formatViolations = (violations: readonly Violation[]): string =>
  `以下位置仍有硬编码文案，应改用 t('...'):\n` +
  violations
    .map((violation) => `  ${violation.path}:${violation.line}  ${violation.text}`)
    .join('\n')

const MAIN_DEBT_HINT = [
  '',
  '处置方式(二选一):',
  '  1. 用户可见(会经 IPC message / 状态 detail / 认证 message / 探测 evidence / 提示语到达界面):',
  '     文案搬进 @shared/i18n/messages.ts，渲染层按 code / key 展示，并把该行登记进',
  '     MAIN_COPY_DEBT_USER_VISIBLE(推荐;这一步涉及 wire 契约，要单独做);',
  '  2. 确属非用户可见(例如只进日志/被 catch 吞掉/当前无消费者):登记进 MAIN_COPY_DEBT_INTERNAL，',
  '     并在该分组的小标题里写明为什么它不可能出现在界面上 —— 这是对“债务只减不增”的有意确认，',
  '     不要为了变绿放宽规则。'
].join('\n')

function migratedPath(name: string): string {
  return name.startsWith('../') ? join(RENDERER_SRC, name.slice(3)) : join(COMPONENTS_DIR, name)
}

describe('i18n 走查护栏（T11 全界面无遗漏）', () => {
  it('渲染层整树(.ts/.tsx/.css,递归)默认受约束:不含硬编码中日韩文案', () => {
    const files = collectSourceFiles(RENDERER_ROOT, RENDERER_EXTENSIONS, isTestFile)
    // 反“空扫”:遍历不到文件时,下面的断言会毫无意义地变绿
    expect(files.length, '渲染层应能遍历到源文件(否则这条护栏是空转)').toBeGreaterThan(15)
    const violations = scanSources(
      files.filter((file) => !isPending(file.path)),
      { allowedLiterals: ALLOWED_LITERALS }
    )
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it('新增文件默认受约束:渲染层根目录、嵌套子目录、CSS 里的文案都会被扫到', () => {
    // 复审 E3 的三种逃逸:根目录新文件 / components/nested/x.tsx / CSS-in-JS 文案
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
      { path: 'src/renderer/src/clean.ts', text: 'export const c = 1\n' }
    ]
    const violations = scanSources(synthetic, { allowedLiterals: ALLOWED_LITERALS })
    expect(violations.map((violation) => `${violation.path}:${violation.line}`)).toEqual([
      'src/renderer/src/NewView.tsx:1',
      'src/renderer/src/components/nested/x.tsx:1',
      'src/renderer/src/styles-extra.css:1'
    ])
  })

  it('目录遍历是递归的:嵌套子目录里的新文件同样会被收集(复审 E3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'i18n-guard-'))
    try {
      mkdirSync(join(dir, 'a/b/c'), { recursive: true })
      writeFileSync(join(dir, 'root.tsx'), 'export const a = 1\n')
      writeFileSync(join(dir, 'a/b/c/deep.tsx'), 'export const b = 2\n')
      writeFileSync(join(dir, 'note.css'), '.a {}\n')
      writeFileSync(join(dir, 'skip.test.tsx'), 'export const c = 3\n')
      const found = collectSourceFiles(dir, RENDERER_EXTENSIONS, isTestFile)
      expect(found.length, '只应收集到非测试的 .ts/.tsx/.css').toBe(3)
      const paths = found.map((file) => file.path)
      expect(paths.some((path) => path.endsWith('root.tsx'))).toBe(true)
      expect(paths.some((path) => path.endsWith('a/b/c/deep.tsx'))).toBe(true)
      expect(paths.some((path) => path.endsWith('note.css'))).toBe(true)
      expect(paths.some((path) => path.endsWith('skip.test.tsx'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('主进程文案受约束:未登记的硬编码中文即失败,债务清单只减不增', () => {
    // 主进程的中文会经 IPC 信封 message / 状态事件 detail / 认证 message / 诊断 evidence
    // 到达界面(渲染层直接展示这些字段),所以必须纳入扫描 —— 不能 blanket-exempt src/main。
    const files = collectSourceFiles(MAIN_ROOT, MAIN_EXTENSIONS, isTestFile)
    expect(files.length, '主进程应能遍历到源文件(否则这条护栏是空转)').toBeGreaterThan(20)
    // 注意:**必须不带 ceiling 扫描**。此前把 MAIN_COPY_DEBT 当 ceiling 传进来,等于让扫描
    // 先把已登记的整行过滤掉,再拿过滤结果去比对同一份清单 —— 于是 `observed` 恒为空、
    // `stale` 恒等于整份清单(断言 `{unregistered:[], stale:[]}` 结构性不可能成立)。
    // 现在:扫描给出「实际看到的中文行」全集,再与清单做双向集合比对。
    const violations = scanSources(files, { logSinks: LOG_SINK_ENABLED })
    const observed = [...new Set(violations.map((violation) => violation.text))].sort()
    const registered = [...MAIN_COPY_DEBT].sort()
    const seen = new Set(observed)
    const unregistered = observed.filter((text) => !registered.includes(text))
    const stale = registered.filter((text) => !seen.has(text))
    expect(
      { unregistered, stale },
      [
        '主进程出现未登记的硬编码中文文案，或债务清单已经过期:',
        formatViolations(violations),
        MAIN_DEBT_HINT
      ].join('\n')
    ).toEqual({ unregistered: [], stale: [] })
    expect(new Set(MAIN_COPY_DEBT).size, '债务清单里不应有重复行').toBe(MAIN_COPY_DEBT.length)
    expect(MAIN_COPY_DEBT.length, '债务清单不应是空的(否则等于没有扫描主进程)').toBeGreaterThan(0)
  })

  it('主进程债务必须逐条归类:用户可见(a) ∪ 内部诊断(b) 恰好等于债务清单', () => {
    // 这条用例是「债务可行动」的机械保证:(b) 不是“先塞进去再说”的口袋 ——
    // 每条中文都得明确回答「会不会显示在界面上」,否则 (a)/(b) 的划分就是自说自话。
    const classified = [...MAIN_COPY_DEBT_USER_VISIBLE, ...MAIN_COPY_DEBT_INTERNAL]
    expect(
      new Set(classified).size,
      '同一条债务只能归一类:(a) 与 (b) 不得重叠'
    ).toBe(classified.length)
    expect([...classified].sort(), '有未归类的债务行(或清单被改坏)').toEqual([...MAIN_COPY_DEBT].sort())
    expect(MAIN_COPY_DEBT_USER_VISIBLE.length, '(a) 用户可见待迁移清单不应为空').toBeGreaterThan(0)
    expect(MAIN_COPY_DEBT_INTERNAL.length, '(b) 内部诊断清单不应为空').toBeGreaterThan(0)
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
    expect(MAIN_EXEMPTIONS.map((entry) => entry.kind)).toEqual(['console-args'])
    // 删掉这条规则会让主进程日志集体违规,所以它不可能被悄悄关掉而不被发现
    expect(LOG_SINK_ENABLED).toBe(true)
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
