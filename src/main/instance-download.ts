/**
 * 实例分区（`persist:inst-<id>`）的下载接管。
 *
 * 工作区视图（workspace-host）与独立实例窗口（window-host）共享同一分区 session，
 * 而 `will-download` 是追加语义（`.on` 家族）：两处都调用 `installInstanceDownloadPolicy`，
 * 由 `createOncePerSession` 保证同一分区只装一个监听器，重复安装为 no-op。
 *
 * 策略：
 * - 落点由用户在系统保存对话框里确认：对话框打开时预填「系统下载目录 + 清洗后的建议文件名」，
 *   重名自动加序号；用户可直接确认，也可改到别处。不静默落盘——下载了什么都得看得见。
 *   页面只提供「建议名」，按不可信输入处理（远程实例可控 content-disposition）。
 * - 下载目录不可用（取不到/不可写）时对话框照常打开，只是没有预填路径。
 *   路径的任何片段都不来自 renderer 或 IPC 输入。
 * - 下载中断（如 SSH 隧道断开）发一次系统通知；用户在保存对话框取消不提示。
 */
import { Notification, app } from 'electron'
import type { DownloadItem, SaveDialogOptions, Session } from 'electron'
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { createTranslator } from '@shared/i18n'
import type { Language } from '@shared/settings'
import { resolveLanguage } from '@shared/settings'
import { systemLocale } from './system-locale'
import { createOncePerSession } from './webview/instance-view'

/** 清洗后文件名的长度上限（含扩展名）；超出则截断并保留扩展名。 */
const MAX_FILENAME_LENGTH = 150

/** 以点结尾/含空格的文件名在 Windows 上会被剥除或拒收，统一在清洗时去掉。 */
const TRAILING_DOT_OR_SPACE = /[. ]+$/

/** Windows 保留设备名（带不带扩展名都冲突）；命中时加前缀避免写盘失败。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 把页面给出的下载建议名清洗为安全的单段文件名。
 *
 * 取最后一段路径分隔符之后的部分（丢弃 `../`、绝对路径与盘符），去掉控制字符、
 * Windows 非法字符与前导点（防隐藏文件与 `..`），空名回落 `download`，
 * 超长截断并保留扩展名。
 */
export function sanitizeDownloadFilename(raw: string): string {
  const lastSegment = raw.split(/[\\/]/).pop() ?? ''
  const withoutControl = [...lastSegment]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
  const cleaned = withoutControl
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .replace(TRAILING_DOT_OR_SPACE, '')
    .trim()
  if (cleaned === '') return 'download'
  const withReserved =
    WINDOWS_RESERVED.test(cleaned) && !cleaned.startsWith('_') ? `_${cleaned}` : cleaned
  if (withReserved.length <= MAX_FILENAME_LENGTH) return withReserved
  const ext = extname(withReserved)
  const keepExt = ext.length > 0 && ext.length < 32 ? ext : ''
  const truncated = withReserved.slice(0, MAX_FILENAME_LENGTH - keepExt.length)
  return `${truncated}${keepExt}`.replace(TRAILING_DOT_OR_SPACE, '') || 'download'
}

/**
 * 为 `dir/name` 挑一个不存在的路径：冲突时在扩展名前插入 ` (1)`、` (2)` …；
 * 超过 999 个重名（异常场景）用时间戳兜底，避免与前缀循环死磕。
 */
export function uniqueDownloadPath(
  dir: string,
  name: string,
  exists: (path: string) => boolean = existsSync
): string {
  if (!exists(join(dir, name))) return join(dir, name)
  const ext = extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  for (let index = 1; index <= 999; index += 1) {
    const candidate = join(dir, `${stem} (${index})${ext}`)
    if (!exists(candidate)) return candidate
  }
  return join(dir, `${stem}-${Date.now()}${ext}`)
}

export interface InstanceDownloadOptions {
  /** 通知文案语言；缺省按系统语言推断。 */
  language?: () => Language
  /** 系统下载目录解析；缺省 `app.getPath('downloads')`。 */
  downloadsDir?: () => string
  /** 中断通知的发送实现；缺省发系统通知（测试可注入）。 */
  notifyInterrupted?: (filename: string, language: Language) => void
}

/** 每分区只装一次下载接管的守卫（WeakSet 随 session 对象存活）。 */
const shouldInstallDownloadPolicy = createOncePerSession<Session>()

/** 取系统下载目录并确认可写；任何一步失败返回 null（调用方不预填默认路径）。 */
function usableDownloadsDir(resolve: () => string): string | null {
  try {
    const dir = resolve()
    if (dir === '') return null
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return dir
  } catch (error) {
    console.error('[instance-download] 默认下载目录不可用，保存对话框不预填路径：', error)
    return null
  }
}

function currentLanguage(options: InstanceDownloadOptions): Language {
  return options.language ? options.language() : resolveLanguage(null, systemLocale())
}

function defaultNotifyInterrupted(filename: string, language: Language): void {
  if (!Notification.isSupported()) return
  const t = createTranslator(language)
  new Notification({
    title: `${t('app.name')} · ${t('download.interrupted.title')}`,
    body: t('download.interrupted.body', { name: filename })
  }).show()
}

function notifyInterrupted(filename: string, options: InstanceDownloadOptions): void {
  try {
    ;(options.notifyInterrupted ?? defaultNotifyInterrupted)(filename, currentLanguage(options))
  } catch (error) {
    // 通知是旁路：文案/平台任何一步失败都不能影响下载主流程的收尾。
    console.error('[instance-download] 下载中断通知发送失败：', error)
  }
}

/**
 * 保存对话框选项：默认路径 = 系统下载目录 + 去重后的清洗文件名（目录不可用时留空，
 * 由 Electron 按上次位置打开）。
 */
export function saveDialogOptions(
  dir: string | null,
  filename: string,
  language: Language
): SaveDialogOptions {
  const t = createTranslator(language)
  const options: SaveDialogOptions = {
    title: t('download.save.title'),
    buttonLabel: t('download.save.button')
  }
  if (dir !== null) options.defaultPath = uniqueDownloadPath(dir, filename)
  return options
}

/** 在实例分区 session 上安装下载接管（每分区一次；重复调用为 no-op）。 */
export function installInstanceDownloadPolicy(
  session: Session,
  options: InstanceDownloadOptions = {}
): void {
  if (!shouldInstallDownloadPolicy(session)) return
  const downloadsDir = options.downloadsDir ?? ((): string => app.getPath('downloads'))
  session.on('will-download', (_event, item: DownloadItem) => {
    const filename = sanitizeDownloadFilename(item.getFilename())
    const dialog = saveDialogOptions(
      usableDownloadsDir(downloadsDir),
      filename,
      currentLanguage(options)
    )
    try {
      item.setSaveDialogOptions(dialog)
    } catch (error) {
      // 不设 savePath 时 Electron 仍会弹出自己的保存对话框，失败只影响预填路径。
      console.error('[instance-download] 设置保存对话框失败：', error)
    }
    item.once('done', (_doneEvent, state) => {
      if (state !== 'interrupted') return
      notifyInterrupted(filename, options)
    })
  })
}
