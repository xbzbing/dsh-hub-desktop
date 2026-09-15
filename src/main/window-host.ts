/**
 * 实例窗口宿主（T3 基础版）。
 *
 * 设计依据：实现计划 §6.6 —— 每实例独立 `BrowserWindow`，`partition: 'persist:inst-<id>'`
 * 隔离存储，禁用 nodeIntegration、开启 contextIsolation/sandbox、拦截外跳。
 * Cookie 注入 / 401 拦截 / 遮罩层属 T6 范围，此处只做「开窗 + 加载就绪 URL」。
 */
import { BrowserWindow } from 'electron'

export interface OpenInstanceViewOptions {
  instanceId: string
  title: string
  url: string
}

/** 已打开的实例窗口（同一实例复用，避免重复开窗） */
const windows = new Map<string, BrowserWindow>()

export function openInstanceWindow(options: OpenInstanceViewOptions): BrowserWindow {
  const existing = windows.get(options.instanceId)
  if (existing && !existing.isDestroyed()) {
    existing.setTitle(options.title)
    existing.loadURL(options.url).catch((error: unknown) => {
      console.error('[window-host] 重新加载实例窗口失败：', error)
    })
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: options.title,
    backgroundColor: '#101318',
    webPreferences: {
      partition: `persist:inst-${options.instanceId}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })

  // 实例页面内的外跳一律拒绝（需要系统浏览器时由页面自身的链接语义决定，T6 再细化）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => windows.delete(options.instanceId))
  windows.set(options.instanceId, win)

  void win.loadURL(options.url)
  return win
}

/** 关闭某实例窗口（实例停止时调用） */
export function closeInstanceWindow(instanceId: string): void {
  const win = windows.get(instanceId)
  if (win && !win.isDestroyed()) win.close()
  windows.delete(instanceId)
}