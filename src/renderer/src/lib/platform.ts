/**
 * 渲染层平台判定。
 *
 * 主进程启动时把 `app:info` 的 `platform` 写入 `<html data-platform>`（见 instance-slice），
 * 渲染层据此判定平台相关快捷键的修饰键（macOS 用 ⌘，其余平台用 Alt）。
 */
export function rendererPlatform(): string {
  if (typeof document === 'undefined') return ''
  return document.documentElement.dataset.platform ?? ''
}
