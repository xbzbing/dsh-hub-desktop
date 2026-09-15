import { readFileSync, readdirSync } from 'node:fs'
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
  'Sidebar.tsx',
  'SettingsView.tsx',
  'AuthPanel.tsx',
  'VaultCard.tsx',
  'EmptyView.tsx'
]

/** 尚未迁移:迁完一个就从这里删掉(清单即进度) */
const PENDING = [
  'DetailView.tsx',
  'Wizard.tsx',
  'HomeView.tsx',
  'SshDialogs.tsx',
  'KeyPreview.tsx',
  'UrlDetect.tsx',
  'Toasts.tsx',
  'Modal.tsx'
]

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/

/**
 * 允许保留的字面量:语言选择器按惯例用**该语言自身**书写(「中文」/English),
 * 翻译它反而会让用户找不到自己的语言。
 */
const ALLOWED_LITERALS = ['中文']

/**
 * 去掉注释后再找文案:注释里出现中文是允许的(本仓库注释就是中文)。
 * 只处理 `//` 与块注释,以及 JSX 里的 `{/* ... *\/}`。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function readComponent(name: string): string {
  return name.startsWith('../')
    ? readFileSync(join(RENDERER_DIR, name.slice(3)), 'utf8')
    : readFileSync(join(COMPONENTS_DIR, name), 'utf8')
}

describe('i18n 走查护栏（T11 全界面无遗漏）', () => {
  it('已迁移的组件不含硬编码中日韩文案', () => {
    const offenders: string[] = []
    for (const name of MIGRATED) {
      const code = stripComments(readComponent(name))
      if (CJK.test(code)) {
        const line = code.split('\n').findIndex((text) => CJK.test(text)) + 1
        const text = code.split('\n')[line - 1] ?? ''
        if (ALLOWED_LITERALS.some((literal) => text.includes(literal))) continue
        offenders.push(`${name}:${line}`)
      }
    }
    expect(offenders, `以下位置仍有硬编码文案,应改用 t('...'):\n${offenders.join('\n')}`).toEqual([])
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

  it('渲染层 lib 不含硬编码文案', () => {
    const offenders: string[] = []
    for (const name of readdirSync(RENDERER_LIB_DIR)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      const code = stripComments(readFileSync(join(RENDERER_LIB_DIR, name), 'utf8'))
      if (CJK.test(code)) {
        const line = code.split('\n').findIndex((text) => CJK.test(text)) + 1
        offenders.push(`${name}:${line}`)
      }
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

  it('托盘状态行的插值参数两种语言都有', () => {
    expect(MESSAGES['tray.status'].zh).toContain('{count}')
    expect(MESSAGES['tray.status'].en).toContain('{count}')
  })
})
