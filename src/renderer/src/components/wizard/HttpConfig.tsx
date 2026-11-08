import type { ReactNode } from 'react'
import { isCleartextEndpoint } from '@shared/endpoint'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import Select from '../Select'
import UrlDetect from '../UrlDetect'
import type { WizardForm } from './types'

export interface HttpConfigProps {
  t: Translator
  form: WizardForm
  set: (
    key: Exclude<keyof WizardForm, 'useDefaultSpace' | 'proxyType'>
  ) => (event: { target: { value: string } }) => void
  setForm: (updater: (current: WizardForm) => WizardForm) => void
}

/** HTTP 直连端点配置：URL 输入 + 可选代理 + 明文告警 + 认证模式探测。 */
export default function HttpConfig({ t, form, set, setForm }: HttpConfigProps): ReactNode {
  const proxyEnabled = form.proxyType !== 'none'
  return (
    <>
      <div className="field mt12">
        <label htmlFor="wizard-url">{t('wizard.urlLabel')}</label>
        <input
          className="input num"
          id="wizard-url"
          placeholder="https://host:8443"
          value={form.endpointUrl}
          onChange={set('endpointUrl')}
          data-testid="wizard-url"
        />
        <span className="hint">{t('wizard.urlHint')}</span>
      </div>

      <div className="field mt12">
        <label htmlFor="wizard-proxy-type">{t('wizard.proxyTypeLabel')}</label>
        <Select
          id="wizard-proxy-type"
          value={form.proxyType}
          onChange={(value) => {
            setForm((current) => ({
              ...current,
              proxyType: value as WizardForm['proxyType'],
              // SOCKS5 不支持认证，切过去时清掉 HTTP 代理的凭据，避免隐藏字段仍被提交。
              ...(value === 'socks5' ? { proxyUsername: '', proxyPassword: '' } : {}),
              // 首次切到代理时给一个常见端口；保留用户已填的值。
              ...(current.proxyPort.trim() === ''
                ? { proxyPort: value === 'socks5' ? '1080' : '8080' }
                : {})
            }))
          }}
          options={[
            { value: 'none', label: t('wizard.proxyNone') },
            { value: 'http', label: t('wizard.proxyHttp') },
            { value: 'socks5', label: t('wizard.proxySocks5') }
          ]}
          testId="wizard-proxy-type"
        />
        <span className="hint">{t('wizard.proxyTypeHint')}</span>
      </div>

      {proxyEnabled && (
        <>
          <div className="grid-2 mt8">
            <div className="field">
              <label htmlFor="wizard-proxy-host">{t('wizard.proxyHostLabel')}</label>
              <input
                className="input num"
                id="wizard-proxy-host"
                placeholder="127.0.0.1"
                value={form.proxyHost}
                onChange={set('proxyHost')}
                data-testid="wizard-proxy-host"
              />
            </div>
            <div className="field">
              <label htmlFor="wizard-proxy-port">{t('wizard.proxyPortLabel')}</label>
              <input
                className="input num"
                id="wizard-proxy-port"
                inputMode="numeric"
                placeholder="8080"
                value={form.proxyPort}
                onChange={set('proxyPort')}
                data-testid="wizard-proxy-port"
              />
            </div>
            {form.proxyType === 'http' && (
              <>
                <div className="field">
                  <label htmlFor="wizard-proxy-username">{t('wizard.proxyUsernameLabel')}</label>
                  <input
                    className="input"
                    id="wizard-proxy-username"
                    autoComplete="off"
                    value={form.proxyUsername}
                    onChange={set('proxyUsername')}
                    data-testid="wizard-proxy-username"
                  />
                </div>
                <div className="field">
                  <label htmlFor="wizard-proxy-password">{t('wizard.proxyPasswordLabel')}</label>
                  <input
                    className="input"
                    id="wizard-proxy-password"
                    type="password"
                    autoComplete="new-password"
                    value={form.proxyPassword}
                    onChange={set('proxyPassword')}
                    data-testid="wizard-proxy-password"
                  />
                </div>
              </>
            )}
          </div>
          <p className="meta mt8">{t('wizard.proxyHint')}</p>
          {form.proxyType === 'socks5' && (
            <p className="meta mt8">{t('wizard.proxySocksNoAuth')}</p>
          )}
          <div className="note n-info mt12" data-testid="wizard-proxy-detect-hint">
            <Icon name="info" />
            <span>{t('wizard.proxyDetectHint')}</span>
          </div>
        </>
      )}

      {/* 直连 HTTP 使用明文数据连接，创建前显示警告。 */}
      {isCleartextEndpoint(form.endpointUrl) && (
        <div className="note n-warn mt12" data-testid="wizard-cleartext-warning">
          <Icon name="alert" />
          <span>{t('wizard.cleartextWarning')}</span>
        </div>
      )}
      {/* 代理模式下探测请求需要先有实例代理配置；创建后由启动探测承担。 */}
      {!proxyEnabled && (
        <div className="mt12">
          <UrlDetect endpointUrl={form.endpointUrl} />
        </div>
      )}
    </>
  )
}
