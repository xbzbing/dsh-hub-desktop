import type { Theme } from '@shared/settings'

export interface NativeThemePort {
  themeSource: Theme
}

/**
 * 将 Hub 的主题偏好同步给 Electron 原生主题源。
 * WebContentsView 内的 dsh 通过 prefers-color-scheme 读取该值；`system` 保留系统跟随语义。
 */
export function applyNativeThemeSource(theme: Theme, port: NativeThemePort): void {
  port.themeSource = theme
}
