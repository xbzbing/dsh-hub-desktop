/**
 * 插件外链打开策略：只允许 https 且域名在白名单（npm registry 网页与 GitHub）。
 *
 * 与 window-host-policy 的外跳白名单相互独立：那处覆盖工作区内的一般外链；本处专用于
 * 插件卡片里 hub 主动生成的 npm/GitHub 地址，域名闸更严（防渲染层借这个通道打开任意站点）。
 */

/** 允许的外链主机（精确匹配或子域）。 */
const ALLOWED_HOSTS = ['npmjs.com', 'www.npmjs.com', 'github.com']

/** 判定一个 URL 是否为允许打开的插件外链（https + 域名白名单）。 */
export function isAllowedPluginLink(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}
