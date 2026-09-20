/**
 * 统一的 E2E Electron 启动参数。
 *
 * - Linux 下用 `--password-store=gnome-libsecret` 固定 safeStorage 后端:
 *   无头会话探测不到桌面环境时 Chromium 会回退 basic_text(非真加密),
 *   凭据保险库按「不可用」降级,跨重启的用例会与真实桌面行为不一致。
 * - CI 无头环境加 `--no-sandbox`。
 * - `DSH_HUB_E2E_ARGS` 追加额外参数(空格分隔,如 `--disable-gpu`)。
 */
export function buildLaunchArgs(): string[] {
  const args: string[] = []
  if (process.platform === 'linux') args.push('--password-store=gnome-libsecret')
  args.push('.')
  if (process.env.CI) args.push('--no-sandbox')
  for (const arg of (process.env.DSH_HUB_E2E_ARGS ?? '').split(' ').filter(Boolean)) {
    args.push(arg)
  }
  return args
}
