import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notifications = vi.hoisted(() => [] as Array<{ title: string; body: string }>)

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    private readonly options: { title: string; body: string }
    constructor(options: { title: string; body: string }) {
      this.options = options
    }
    show(): void {
      notifications.push(this.options)
    }
  },
  app: { getPath: vi.fn(() => '/nonexistent-default-downloads') }
}))

import {
  installInstanceDownloadPolicy,
  sanitizeDownloadFilename,
  uniqueDownloadPath
} from './instance-download'
import type { InstanceDownloadOptions } from './instance-download'

interface FakeItem {
  getFilename: ReturnType<typeof vi.fn>
  setSavePath: ReturnType<typeof vi.fn>
  setSaveDialogOptions: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
}

interface FakeSession {
  on: ReturnType<typeof vi.fn>
}

function fakeSession(): FakeSession {
  return { on: vi.fn() }
}

function willDownloadListener(
  session: FakeSession
): (event: { preventDefault: ReturnType<typeof vi.fn> }, item: FakeItem) => void {
  const call = session.on.mock.calls.find((entry) => entry[0] === 'will-download')
  expect(call, '应当安装 will-download 监听').toBeDefined()
  return call?.[1] as never
}

function fakeItem(filename: string): FakeItem & { fireDone: (state: string) => void } {
  let doneListener: ((event: unknown, state: string) => void) | null = null
  return {
    getFilename: vi.fn(() => filename),
    setSavePath: vi.fn(),
    setSaveDialogOptions: vi.fn(),
    once: vi.fn((event: string, listener: (stateEvent: unknown, state: string) => void) => {
      if (event === 'done') doneListener = listener
    }),
    fireDone: (state: string) => doneListener?.({}, state)
  }
}

describe('sanitizeDownloadFilename（页面建议名按不可信输入清洗）', () => {
  it('丢弃路径成分：../、绝对路径与 Windows 盘符只留最后一段', () => {
    expect(sanitizeDownloadFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeDownloadFilename('/home/user/report.json')).toBe('report.json')
    expect(sanitizeDownloadFilename('C:\\Users\\x\\导出.json')).toBe('导出.json')
    expect(sanitizeDownloadFilename('..\\..\\evil.txt')).toBe('evil.txt')
  })

  it('去掉控制字符与 Windows 非法字符，前导点不产生隐藏文件', () => {
    expect(sanitizeDownloadFilename('a\u0000b\u001fc.txt')).toBe('abc.txt')
    expect(sanitizeDownloadFilename('a<b>:c"d|e?f*g.txt')).toBe('a_b__c_d_e_f_g.txt')
    expect(sanitizeDownloadFilename('.hidden')).toBe('hidden')
    expect(sanitizeDownloadFilename('..')).toBe('download')
    expect(sanitizeDownloadFilename('')).toBe('download')
    expect(sanitizeDownloadFilename('   ')).toBe('download')
  })

  it('Windows 保留设备名加前缀，结尾点/空格去掉', () => {
    expect(sanitizeDownloadFilename('CON')).toBe('_CON')
    expect(sanitizeDownloadFilename('lpt1.txt')).toBe('_lpt1.txt')
    expect(sanitizeDownloadFilename('report.json. ')).toBe('report.json')
  })

  it('超长截断并保留扩展名（150 上限）', () => {
    const long = `${'x'.repeat(400)}.json`
    const result = sanitizeDownloadFilename(long)
    expect(result.length).toBeLessThanOrEqual(150)
    expect(result.endsWith('.json')).toBe(true)
  })
})

describe('uniqueDownloadPath（重名自动改名不覆盖）', () => {
  it('不存在时用原名', () => {
    expect(uniqueDownloadPath('/dl', 'a.json', () => false)).toBe(join('/dl', 'a.json'))
  })

  it('已存在时在扩展名前插入序号', () => {
    const existing = new Set([join('/dl', 'a.json'), join('/dl', 'a (1).json')])
    expect(uniqueDownloadPath('/dl', 'a.json', (path) => existing.has(path))).toBe(
      join('/dl', 'a (2).json')
    )
  })

  it('无扩展名同样插序号', () => {
    const existing = new Set([join('/dl', 'LICENSE')])
    expect(uniqueDownloadPath('/dl', 'LICENSE', (path) => existing.has(path))).toBe(
      join('/dl', 'LICENSE (1)')
    )
  })
})

describe('installInstanceDownloadPolicy（受控放行）', () => {
  let dir: string

  beforeEach(() => {
    notifications.length = 0
    dir = mkdtempSync(join(tmpdir(), 'dsh-dl-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function install(overrides: InstanceDownloadOptions = {}): FakeSession {
    const session = fakeSession()
    installOn(session, { downloadsDir: () => dir, language: () => 'zh', ...overrides })
    return session
  }

  /** 假 session 只实现被测代码触达的 `on`；按 electron `Session` 传入。 */
  function installOn(target: FakeSession, options: InstanceDownloadOptions): void {
    const session = target as unknown as Parameters<typeof installInstanceDownloadPolicy>[0]
    installInstanceDownloadPolicy(session, options)
  }

  it('同一分区重复安装只保留一个监听器（追加语义防叠加）', () => {
    const session = fakeSession()
    installOn(session, { downloadsDir: () => dir })
    installOn(session, { downloadsDir: () => dir })
    expect(session.on.mock.calls.filter((entry) => entry[0] === 'will-download')).toHaveLength(1)
  })

  it('默认目录可用：保存对话框预填「下载目录 + 清洗后的文件名」，不静默落盘', () => {
    const session = install()
    const listener = willDownloadListener(session)
    const event = { preventDefault: vi.fn() }
    const item = fakeItem('../../evil name.json')
    listener(event, item)
    expect(event.preventDefault).not.toHaveBeenCalled()
    // 落点由用户确认：不调用 setSavePath（那会跳过对话框），只给对话框预填默认路径。
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({
      title: '保存下载的文件',
      buttonLabel: '保存',
      defaultPath: join(dir, 'evil name.json')
    })
  })

  it('重名文件默认路径自动加序号，不预填成覆盖', () => {
    writeFileSync(join(dir, 'export.json'), 'old')
    const session = install()
    const listener = willDownloadListener(session)
    const item = fakeItem('export.json')
    listener({ preventDefault: vi.fn() }, item)
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: join(dir, 'export (1).json') })
    )
  })

  it('默认目录不可用：对话框照常打开，只是不预填路径', () => {
    const session = install({ downloadsDir: () => '' })
    const listener = willDownloadListener(session)
    const event = { preventDefault: vi.fn() }
    const item = fakeItem('export.json')
    listener(event, item)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({
      title: '保存下载的文件',
      buttonLabel: '保存'
    })
  })

  it('目录创建失败（路径被文件占用）同样只开对话框', () => {
    // 下载目录落在一个普通文件之下 → mkdirSync 必失败 → 判为不可用
    writeFileSync(join(dir, 'occupied'), 'x')
    const session = install({ downloadsDir: () => join(dir, 'occupied', 'downloads') })
    const listener = willDownloadListener(session)
    const item = fakeItem('export.json')
    listener({ preventDefault: vi.fn() }, item)
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(item.setSaveDialogOptions.mock.calls[0]?.[0]).not.toHaveProperty('defaultPath')
  })

  it('设置对话框失败不影响下载（不取消事件、不抛错）', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const session = install()
    const listener = willDownloadListener(session)
    const event = { preventDefault: vi.fn() }
    const item = fakeItem('x.json')
    item.setSaveDialogOptions.mockImplementation(() => {
      throw new Error('dialog backend down')
    })
    expect(() => listener(event, item)).not.toThrow()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('下载中断 → 发一次系统通知，标题走 i18n 目录', () => {
    const session = install({ language: () => 'zh' })
    const listener = willDownloadListener(session)
    const item = fakeItem('session-export.json')
    listener({ preventDefault: vi.fn() }, item)
    item.fireDone('interrupted')
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.title).toBe('DSH Hub · 下载中断')
    expect(notifications[0]?.body).toContain('session-export.json')
  })

  it('下载完成/用户取消不发通知', () => {
    const session = install({ language: () => 'zh' })
    const listener = willDownloadListener(session)
    const item = fakeItem('ok.json')
    listener({ preventDefault: vi.fn() }, item)
    item.fireDone('completed')
    item.fireDone('cancelled')
    expect(notifications).toHaveLength(0)
  })

  it('通知发送抛错不影响下载主流程（旁路不冒泡）', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const session = install({
      language: () => 'zh',
      notifyInterrupted: () => {
        throw new Error('notification backend down')
      }
    })
    const listener = willDownloadListener(session)
    const item = fakeItem('x.json')
    listener({ preventDefault: vi.fn() }, item)
    expect(() => item.fireDone('interrupted')).not.toThrow()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('注入的通知实现收到清洗后的文件名与语言', () => {
    const notifyInterrupted = vi.fn()
    const session = install({ language: () => 'en', notifyInterrupted })
    const listener = willDownloadListener(session)
    const item = fakeItem('../payload.sh')
    listener({ preventDefault: vi.fn() }, item)
    item.fireDone('interrupted')
    expect(notifyInterrupted).toHaveBeenCalledWith('payload.sh', 'en')
  })
})
