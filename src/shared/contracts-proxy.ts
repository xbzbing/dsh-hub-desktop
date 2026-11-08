/**
 * 远程 HTTP 实例的代理配置。
 *
 * 代理凭据只允许密码进入 vault；本模块的 `ProxyConfig` 是注册表里的非敏感形态，
 * 不含密码。`ProxyInput` 仅出现在创建/更新入参里，落盘前由注册表剥掉密码。
 *
 * 本模块不 import electron；主进程、渲染进程和测试共用同一份校验与格式化逻辑。
 */
import { z } from 'zod'

/** 代理协议：HTTP 代理（含 HTTPS 目标经 CONNECT）与 SOCKS5。 */
export const PROXY_TYPES = ['http', 'socks5'] as const
export type ProxyType = (typeof PROXY_TYPES)[number]

const PROXY_PORT_SCHEMA = z
  .number('proxy.errPortNumber')
  .int('proxy.errPortInteger')
  .min(1, 'proxy.errPortMin')
  .max(65535, 'proxy.errPortMax')

/**
 * 代理主机：主机名、IPv4、裸 IPv6，或方括号包裹的 IPv6。
 * 端口单独存放，不接受 `host:port` 组合形式；不允许空白、斜杠和 userinfo。
 */
const PROXY_HOST_SCHEMA = z
  .string()
  .trim()
  .min(1, 'proxy.errHostRequired')
  .max(255, 'proxy.errHostTooLong')
  .refine(
    (value) =>
      /^[A-Za-z0-9._:[\]]+$/.test(value) &&
      (value.startsWith('[')
        ? /^\[[0-9A-Fa-f:.]+\]$/.test(value)
        : !value.includes(':') || (value.split(':').length >= 3 && /^[0-9A-Fa-f:.]+$/.test(value))),
    'proxy.errHostFormat'
  )

const PROXY_USERNAME_SCHEMA = z
  .string()
  .trim()
  .min(1, 'proxy.errUsernameRequired')
  .max(128, 'proxy.errUsernameTooLong')

/** 注册表里的代理配置：只含非敏感字段。 */
export const ProxyConfigSchema = z
  .object({
    type: z.enum(PROXY_TYPES),
    host: PROXY_HOST_SCHEMA,
    port: PROXY_PORT_SCHEMA,
    /** 需要认证时的用户名；密码单独存 vault，绝不写进注册表。 */
    username: PROXY_USERNAME_SCHEMA.nullable().optional()
  })
  .strict()
  .superRefine((proxy, ctx) => {
    // Chromium 的 SOCKS5 客户端只提供 no-auth 方法（实测 greeting 仅 0x00），
    // 配置用户名/密码也无法完成握手；提前拒绝，避免用户以为认证已生效。
    if (proxy.type === 'socks5' && proxy.username) {
      ctx.addIssue({
        code: 'custom',
        message: 'proxy.errSocksNoAuth',
        path: ['username']
      })
    }
  })
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>

/**
 * 创建/更新入参里的代理配置。`password` 只在 IPC 入参中出现：
 * - `undefined`：新建时不使用密码；更新时保持 vault 中的现有密码；
 * - `null`：更新时清除已保存的密码；
 * - 字符串：写入 vault。
 */
export const ProxyInputSchema = z
  .object({
    type: z.enum(PROXY_TYPES),
    host: PROXY_HOST_SCHEMA,
    port: PROXY_PORT_SCHEMA,
    username: PROXY_USERNAME_SCHEMA.nullable().optional(),
    password: z
      .string()
      .min(1, 'proxy.errPasswordEmpty')
      .max(1024, 'proxy.errPasswordTooLong')
      .nullable()
      .optional()
  })
  .strict()
  .superRefine((proxy, ctx) => {
    if (proxy.type === 'socks5') {
      if (proxy.username) {
        ctx.addIssue({
          code: 'custom',
          message: 'proxy.errSocksNoAuth',
          path: ['username']
        })
      }
      if (typeof proxy.password === 'string') {
        ctx.addIssue({
          code: 'custom',
          message: 'proxy.errSocksNoAuth',
          path: ['password']
        })
      }
      return
    }
    if (typeof proxy.password === 'string' && !proxy.username) {
      ctx.addIssue({
        code: 'custom',
        message: 'proxy.errPasswordNeedsUsername',
        path: ['password']
      })
    }
  })
export type ProxyInput = z.input<typeof ProxyInputSchema>
export type ProxyInputParsed = z.output<typeof ProxyInputSchema>

/** 代理地址（不含凭据）；IPv6 统一加方括号，供展示与 proxyRules 复用。 */
export function proxyHostForUrl(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('[')) return trimmed
  return trimmed.includes(':') ? `[${trimmed}]` : trimmed
}

/** 展示用地址，如 `http://127.0.0.1:7897` / `socks5://[::1]:1080`。 */
export function proxyAddress(proxy: ProxyConfig): string {
  return `${proxy.type}://${proxyHostForUrl(proxy.host)}:${proxy.port}`
}

/**
 * Chromium `proxyRules`：http 代理同时处理 http 与 https（https 目标走 CONNECT），
 * socks5 则所有协议都走 SOCKS5，由 Chromium 做远端 DNS。
 */
export function proxyRulesFor(proxy: ProxyConfig | null | undefined): string | null {
  if (!proxy) return null
  return `${proxy.type}://${proxyHostForUrl(proxy.host)}:${proxy.port}`
}

/** 是否配置了需要认证的代理；密码是否存在由主进程另行检查。 */
export function proxyUsesAuth(proxy: ProxyConfig | null | undefined): boolean {
  return Boolean(proxy?.username)
}

/** 从创建/更新入参中剥掉密码，得到可落盘的代理配置。 */
export function proxyConfigOf(input: ProxyInputParsed | null | undefined): ProxyConfig | null {
  if (!input) return null
  return {
    type: input.type,
    host: input.host.trim(),
    port: input.port,
    ...(input.username?.trim() ? { username: input.username.trim() } : {})
  }
}
