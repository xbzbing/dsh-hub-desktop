import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STATUS_INFO, toDisplayStatus, toStatusInfo } from './format'
import type { DisplayStatus } from './format'

/**
 * 状态圆点映射护栏（用户反馈 #7：总览列表的状态原点恒为灰色）。
 *
 * 缺陷根因**不在映射层**：`toDisplayStatus` 一直是正确的（同一行的胶囊拿到了正确的
 * labelKey/chipClass），坏的是总览表行把圆点写成死类名 `className="status-dot"`，
 * 于是圆点永远只落到 `.status-dot` 的基色 `--idle`（灰），与旁边的胶囊自相矛盾。
 *
 * 因此这里钉两层：
 * 1. **映射层**（纯函数）：运行时四态 → 圆点修饰类必须是非灰的对应色，且圆点与胶囊同源；
 * 2. **词法层**（读源码）：渲染层任何 `status-dot` 的 className 都必须来自带插值的
 *    模板字面量 —— 这条正是缺陷 #7 那次写法会失败的地方（第 4 个用例用合成源码反证）。
 *
 * **本文件不渲染任何组件**：仓库 vitest 跑在 `environment: 'node'`，无 jsdom /
 * testing-library，且 `.test.tsx` 不被 include 收集。所以「HomeView 真的把 dotClass
 * 拼进了 DOM」这一步由第 4 个用例的源码护栏代替**证明**，而不是靠渲染断言。
 */

/** 运行时四态 → 期望的圆点修饰类（`''` = `.status-dot` 基色 `--idle`，即灰） */
const EXPECTED_DOT: ReadonlyArray<{ status: Parameters<typeof toStatusInfo>[0]; dot: string }> = [
  { status: undefined, dot: '' },
  { status: 'stopped', dot: '' },
  { status: 'starting', dot: 's-connecting' },
  { status: 'running', dot: 's-connected' },
  { status: 'error', dot: 's-error' }
]

describe('状态 → 展示圆点映射（用户反馈 #7）', () => {
  it('运行时状态映射到共享的圆点修饰类:运行中必须是绿点而不是底色灰点', () => {
    for (const { status, dot } of EXPECTED_DOT) {
      expect(toStatusInfo(status).dotClass, `status=${String(status)}`).toBe(dot)
    }
  })

  it('运行中(status=running)的圆点修饰类必须非空 —— 直接钉住「运行中却显示灰点」', () => {
    // 这条是缺陷 #7 的最小复现断言:此前的写法让圆点恒为 `.status-dot` 基色,
    // 无论 statuses 里是什么。映射层一旦退回「一律灰」,这条立刻 RED。
    expect(toStatusInfo('running').dotClass).not.toBe('')
    expect(toStatusInfo('starting').dotClass).not.toBe('')
    expect(toStatusInfo('error').dotClass).not.toBe('')
    // 灰点是 idle 的**专属**语义(未连接/已停止),不能拿它兜住所有状态
    expect(toStatusInfo(undefined).dotClass).toBe('')
  })

  it('圆点与胶囊同源:同一个 toStatusInfo 出口同时给出两者的类名与文案,不会各说各话', () => {
    for (const { status } of EXPECTED_DOT) {
      const info = toStatusInfo(status)
      const display: DisplayStatus = toDisplayStatus(status)
      expect(info).toBe(STATUS_INFO[display])
      expect(info.dotClass).toBe(STATUS_INFO[display].dotClass)
      expect(info.chipClass).toBe(STATUS_INFO[display].chipClass)
      expect(info.labelKey).toBe(STATUS_INFO[display].labelKey)
    }
  })

  it('映射是状态事件的纯函数:同一实例状态推进时圆点依次变化,不依赖挂载时机或行创建', () => {
    // 主进程 `onInstanceStatus` 的推进序列(starting → running → error → stopped):
    // 每一帧都只由「最新事件的 status」决定,所以列表重渲染即得到正确圆点。
    const sequence: Array<'starting' | 'running' | 'error' | 'stopped'> = [
      'starting',
      'running',
      'error',
      'stopped'
    ]
    expect(sequence.map((status) => toStatusInfo(status).dotClass)).toEqual([
      's-connecting',
      's-connected',
      's-error',
      ''
    ])
  })

  it('展示层发出的非空圆点类名必须在 styles.css 里有对应选择器(避免再一次静默落回灰底)', () => {
    // 跨文件契约:类名拼对了但 CSS 里没有规则 → 圆点仍然是基色灰,且不会有任何报错。
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    const modifiers = Object.values(STATUS_INFO)
      .map((info) => info.dotClass)
      .filter((dotClass) => dotClass !== '')
    expect(modifiers.length, '至少要有非灰状态,否则这条护栏是空转').toBeGreaterThan(0)
    for (const modifier of modifiers) {
      expect(new RegExp(`\\.${modifier}\\b`).test(css), `styles.css 缺少 .${modifier}`).toBe(true)
    }
  })
})

// ───────────────────── 词法护栏：圆点的 className 不许写死 ─────────────────────

export interface SourceFile {
  path: string
  text: string
}

/**
 * 找出「写死类名的状态圆点」——带 `status-dot` 的 `className` 里没有 `${...dotClass}`
 * 插值。返回 `路径:行` 供断言。纯函数,因此可以用合成源码反证它真的会抓（见下）。
 *
 * 只判定**同一行里同时出现 `className` 与 `status-dot`** 的行:注释里提到 `status-dot`
 * （例如说明这条护栏本身的注释）不含 `className`,不会被误报。
 */
export function findHardcodedStatusDots(files: readonly SourceFile[]): string[] {
  const violations: string[] = []
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      if (!line.includes('status-dot') || !line.includes('className')) return
      // 允许的写法:`className={`status-dot ${info.dotClass}`}`
      // 违规的写法:`className="status-dot"`（缺陷 #7 的原样）
      const interpolated = /`[^`]*\$\{[^}]*dotClass[^}]*\}[^`]*`/.test(line)
      if (!interpolated) violations.push(`${file.path}:${index + 1}`)
    })
  }
  return violations
}

function collectTsx(dir: string): SourceFile[] {
  const found: SourceFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...collectTsx(full))
      continue
    }
    if (!entry.name.endsWith('.tsx')) continue
    found.push({
      path: relative(process.cwd(), full).split(sep).join('/'),
      text: readFileSync(full, 'utf8')
    })
  }
  return found
}

describe('状态圆点写死类名护栏', () => {
  it('反证:缺陷 #7 的原样写法会被抓住,修好后的写法不会', () => {
    const synthetic: SourceFile[] = [
      {
        path: 'src/renderer/src/components/Broken.tsx',
        text: '<span className="status-dot" aria-hidden="true" />\n'
      },
      {
        path: 'src/renderer/src/components/Fixed.tsx',
        text: '<span className={`status-dot ${props.info.dotClass}`} aria-hidden="true" />\n'
      }
    ]
    expect(findHardcodedStatusDots(synthetic)).toEqual([
      'src/renderer/src/components/Broken.tsx:1'
    ])
  })

  it('渲染层所有 status-dot 的类名都来自共享映射(不得写死)', () => {
    const files = collectTsx(join(process.cwd(), 'src/renderer/src/components'))
    // 反「空扫」:收集不到文件时下面的断言会毫无意义地变绿
    expect(files.length, '应能遍历到组件源文件').toBeGreaterThan(5)
    const violations = findHardcodedStatusDots(files)
    expect(
      violations,
      `以下状态圆点写死了类名(会恒为灰色基色),应改为 \`status-dot \${info.dotClass}\`:\n  ` +
        violations.join('\n  ')
    ).toEqual([])
  })
})
