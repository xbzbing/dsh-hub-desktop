/**
 * 代理表单的草稿与补丁构造（纯逻辑，不触碰 IPC / DOM）。
 *
 * 详情页的「编辑代理」与实例编辑对话框共用同一套字段与校验：两处若各自实现，
 * 很容易出现「一处允许保存、另一处拒绝」的口径漂移。校验失败返回文案 key，
 * 由调用方按自己的 toast 习惯渲染。
 */
import type { ProxyConfig, ProxyInput, ProxyType } from '@shared/contracts'
import type { MessageKey } from '@shared/i18n/messages'

/** 表单草稿：数值字段保持字符串，避免输入过程中的中间态被 Number 吞掉。 */
export interface ProxyDraft {
  type: ProxyType | 'none'
  host: string
  port: string
  username: string
  password: string
  /** 清空已保存密码：仅当记录里已有代理、且用户显式勾选时生效。 */
  clearPassword: boolean
}

/** 构造补丁的返回：成功给出 `proxy`（null = 直连），失败给出文案 key。 */
export type ProxyPatchResult =
  { ok: true; proxy: ProxyInput | null } | { ok: false; messageKey: MessageKey }

/** 从注册表记录里的代理（可能为空）得到表单草稿。 */
export function proxyDraftOf(proxy: ProxyConfig | null | undefined): ProxyDraft {
  if (!proxy) {
    return {
      type: 'none',
      host: '',
      port: '8080',
      username: '',
      password: '',
      clearPassword: false
    }
  }
  return {
    type: proxy.type,
    host: proxy.host,
    port: String(proxy.port),
    username: proxy.username ?? '',
    password: '',
    clearPassword: false
  }
}

/**
 * 切换代理类型时的草稿修正：SOCKS5 无认证，切过去要清掉 HTTP 代理的凭据；
 * 首次切到代理时给一个常见端口，但保留用户已填的值。
 */
export function switchProxyType(draft: ProxyDraft, type: ProxyType | 'none'): ProxyDraft {
  const next = { ...draft, type }
  if (type === 'socks5') {
    next.username = ''
    next.password = ''
    next.clearPassword = false
  }
  if (type !== 'none' && draft.port.trim() === '') {
    next.port = type === 'socks5' ? '1080' : '8080'
  }
  return next
}

/**
 * 把草稿转成 `instances.update` 的 `proxy` 入参。
 *
 * `existing` 是记录里当前的代理：密码留空表示沿用 vault 中的密码，
 * 只有用户名变了才强制重填；`clearPassword` 与填写密码互斥。
 */
export function buildProxyPatch(
  draft: ProxyDraft,
  existing: ProxyConfig | null | undefined
): ProxyPatchResult {
  if (draft.type === 'none') return { ok: true, proxy: null }

  const host = draft.host.trim()
  if (host === '') return { ok: false, messageKey: 'edit.proxyRequired' }

  const port = Number(draft.port.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, messageKey: 'edit.proxyPortInvalid' }
  }

  const username = draft.type === 'http' ? draft.username.trim() : ''
  const password = draft.type === 'http' ? draft.password : ''
  const existingUsername = existing?.username ?? null

  if (draft.type === 'http') {
    if (username === '' && password !== '') {
      return { ok: false, messageKey: 'edit.proxyUsernameRequired' }
    }
    if (username !== '' && draft.clearPassword) {
      return { ok: false, messageKey: 'edit.proxyPasswordClearConflict' }
    }
    if (username !== '' && password === '' && existingUsername !== username) {
      return { ok: false, messageKey: 'edit.proxyPasswordRequired' }
    }
  }

  return {
    ok: true,
    proxy: {
      type: draft.type,
      host,
      port,
      ...(username !== '' ? { username } : {}),
      ...(password !== ''
        ? { password }
        : draft.type === 'http' && draft.clearPassword
          ? { password: null }
          : {})
    }
  }
}
