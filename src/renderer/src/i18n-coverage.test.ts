import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MESSAGES, MESSAGE_KEYS } from '@shared/i18n/messages'

/**
 * i18n 走查护栏（T11）。
 *
 * 「中英切换全界面无遗漏」如果只靠人工走查,必然随时间腐化。这里用一条机械规则把它
 * 变成可执行断言:**渲染层组件里不允许出现硬编码中日韩文案**(注释与已迁移的白名单除外)。
 *
 * 已迁移的文件列在 ALLOWLIST 之外 —— 也就是说,新文件默认受约束;
 * 尚未迁移的文件列在 PENDING 里,迁一个就删一行,剩余清单本身就是进度表。
 */
const RENDERER_DIR = join(process.cwd(), 'src/renderer/src')
const COMPONENTS_DIR = join(RENDERER_DIR, 'components')
const RENDERER_LIB_DIR = join(RENDERER_DIR, 'lib')

/** 已完成文案迁移的文件(出现中日韩文案即失败);`../App.tsx` 表示渲染层根组件 */
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

/** 尚未迁移:迁完一个就从这里删掉(清单即进度) */
const PENDING: string[] = []

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/

/**
 * 允许保留的字面量:语言选择器按惯例用**该语言自身**书写(「中文」/English),
 * 翻译它反而会让用户找不到自己的语言。
 */
const ALLOWED_LITERALS = [/^\{?language === 'zh' \? '中文' : 'English'\}?$/]

/**
 * 去掉注释后再找文案:注释里出现中文是允许的(本仓库注释就是中文)。
 * 只处理 `//` 与块注释,以及 JSX 里的 `{/* ... *\/}`。
 */
function stripComments(source: string): string {
  return source
    // 块注释**保留其换行数**:直接删除会把后续行号整体上移,报错位置失真(复审 E10)
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 递归收集目录下的源文件(此前用非递归 readdirSync,嵌套目录整体逃逸,复审 E3) */
function collectSources(root: string, extensions: readonly string[]): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) found.push(...collectSources(full, extensions))
    else if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(full)
  }
  return found
}

function componentPath(name: string): string {
  return name.startsWith('../')
    ? join(RENDERER_DIR, name.slice(3))
    : join(COMPONENTS_DIR, name)
}

function readComponent(name: string): string {
  return readFileSync(componentPath(name), 'utf8')
}

describe('i18n 走查护栏（T11 全界面无遗漏）', () => {
  it('已迁移的组件不含硬编码中日韩文案(**逐行**扫描)', () => {
    // 曾经的实现只找「第一处」中日韩文案、且命中豁免词就 `continue` **整个文件** ——
    // 于是 SettingsView.tsx(第一处是语言选择器的『中文』)与 store.ts 被整体豁免,
    // 复审据此在自己的文件里绕过了这条护栏。现在逐行判定,豁免只作用于该行。
    const offenders: string[] = []
    for (const name of MIGRATED) {
      // 从清单里删掉一项就能让护栏「通过」—— 必须断言条目真实存在(复审 S11b)
      expect(existsSync(componentPath(name)), `${name} 已不在磁盘上,请修正 MIGRATED 清单`).toBe(
        true
      )
      const lines = stripComments(readComponent(name)).split('\n')
      lines.forEach((text, index) => {
        if (!CJK.test(text)) return
        // 精确匹配整行:此前用 `includes('中文')` 会让**任何**含「中文」的行整行豁免,
        // 等于给同一行上的任意中文文案洗白(复审 E7)
        if (ALLOWED_LITERALS.some((pattern) => pattern.test(text.trim()))) return
        offenders.push(`${name}:${index + 1}`)
      })
    }
    expect(offenders, `以下位置仍有硬编码文案,应改用 t('...'):\n${offenders.join('\n')}`).toEqual([])
  })

  it('渲染层根目录的带文案文件不得从 MIGRATED 中移除(防止护栏被「缩小范围」绕过)', () => {
    // 复审 S11b:把条目从 MIGRATED 删掉就能让护栏通过。这里钉住**已知带用户文案**的
    // 渲染层根文件 —— 它们不在 components/ 下,不受下面「未登记组件」检查覆盖。
    for (const required of ['../App.tsx', '../store.ts']) {
      expect(MIGRATED, `${required} 必须保留在 MIGRATED 中(否则该文件的硬编码文案不再受检查)`).toContain(
        required
      )
    }
  })

  it('PENDING 清单与磁盘一致(迁完必须从清单里删掉,避免进度虚报)', () => {
    const files = readdirSync(COMPONENTS_DIR).filter((name) => name.endsWith('.tsx'))
    for (const name of PENDING) {
      expect(files, `${name} 已不存在,请从 PENDING 移除`).toContain(name)
    }
    // 未列在任一清单里的组件视为「已迁移」(默认受约束),避免新文件绕过护栏
    const unlisted = files.filter((name) => !MIGRATED.includes(name) && !PENDING.includes(name))
    expect(unlisted, `新组件必须加入 MIGRATED(默认可含硬编码文案会破坏双语完整性)`).toEqual([])
  })

  it('渲染层 lib 不含硬编码文案(递归,含 .tsx)', () => {
    // 此前只扫 lib 顶层且只看 .ts —— 嵌套目录与 lib/*.tsx 整体逃逸(复审 E3b/E5b)
    const offenders: string[] = []
    for (const file of collectSources(RENDERER_LIB_DIR, ['.ts', '.tsx'])) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((text, index) => {
        if (CJK.test(text)) offenders.push(`${file.replace(`${process.cwd()}/`, '')}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
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
    // 只做「目录 → 存在性」方向:反向的「死键」检测需要扫描全部源码字符串,
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
