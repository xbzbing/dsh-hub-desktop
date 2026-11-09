import type { ReactNode } from 'react'
import type { ProxyConfig } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import type { ProxyDraft } from '../lib/proxy-form'

export interface ProxyFieldsProps {
  t: Translator
  draft: ProxyDraft
  /** 记录里已有的代理；决定是否显示「清空已保存密码」。 */
  existingProxy: ProxyConfig | null
  /** id / data-testid 前缀，如 `edit-proxy`、`proxy-dialog`。 */
  idPrefix: string
  onChange: (updater: (current: ProxyDraft) => ProxyDraft) => void
}

/**
 * 代理主机、端口与 HTTP 凭据字段。
 * 「编辑实例」与独立代理对话框共用同一份表单，避免两处校验与字段形态漂移。
 */
export default function ProxyFields({
  t,
  draft,
  existingProxy,
  idPrefix,
  onChange
}: ProxyFieldsProps): ReactNode {
  if (draft.type === 'none') return null
  return (
    <>
      <div className="grid-2 mt8">
        <div className="field">
          <label htmlFor={`${idPrefix}-host`}>{t('wizard.proxyHostLabel')}</label>
          <input
            className="input num"
            id={`${idPrefix}-host`}
            placeholder="127.0.0.1"
            value={draft.host}
            onChange={(event) => onChange((current) => ({ ...current, host: event.target.value }))}
            data-testid={`${idPrefix}-host`}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-port`}>{t('wizard.proxyPortLabel')}</label>
          <input
            className="input num"
            id={`${idPrefix}-port`}
            inputMode="numeric"
            placeholder="8080"
            value={draft.port}
            onChange={(event) => onChange((current) => ({ ...current, port: event.target.value }))}
            data-testid={`${idPrefix}-port`}
          />
        </div>
        {draft.type === 'http' && (
          <>
            <div className="field">
              <label htmlFor={`${idPrefix}-username`}>{t('wizard.proxyUsernameLabel')}</label>
              <input
                className="input"
                id={`${idPrefix}-username`}
                autoComplete="off"
                value={draft.username}
                onChange={(event) =>
                  onChange((current) => ({ ...current, username: event.target.value }))
                }
                data-testid={`${idPrefix}-username`}
              />
            </div>
            <div className="field">
              <label htmlFor={`${idPrefix}-password`}>{t('wizard.proxyPasswordLabel')}</label>
              <input
                className="input"
                id={`${idPrefix}-password`}
                type="password"
                autoComplete="new-password"
                placeholder={t('edit.proxyPasswordKeep')}
                value={draft.password}
                onChange={(event) => {
                  const value = event.target.value
                  onChange((current) => ({
                    ...current,
                    password: value,
                    ...(value !== '' ? { clearPassword: false } : {})
                  }))
                }}
                data-testid={`${idPrefix}-password`}
              />
            </div>
          </>
        )}
      </div>
      {draft.type === 'socks5' && <p className="meta mt8">{t('wizard.proxySocksNoAuth')}</p>}
      {existingProxy && draft.type === 'http' && (
        <label className="row mt8" style={{ gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={draft.clearPassword}
            onChange={(event) => {
              const checked = event.target.checked
              onChange((current) => ({
                ...current,
                clearPassword: checked,
                ...(checked ? { password: '' } : {})
              }))
            }}
            data-testid={`${idPrefix}-clear-password`}
          />
          <span>{t('edit.proxyClearPassword')}</span>
        </label>
      )}
      <p className="meta mt8">{t('edit.proxyPasswordHint')}</p>
    </>
  )
}
