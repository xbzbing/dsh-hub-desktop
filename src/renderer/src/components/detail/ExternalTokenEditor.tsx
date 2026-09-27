import type { ReactNode } from 'react'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'

export interface ExternalTokenEditorProps {
  t: Translator
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  busy: boolean
}

/** 外部接管 dsh 的访问 token 编辑卡：本机 dsh 重启后更新 browser-auth token。 */
export default function ExternalTokenEditor(props: ExternalTokenEditorProps): ReactNode {
  const { t, value, onChange, onSubmit, busy } = props
  return (
    <div className="card mt12" data-testid="external-token-editor">
      <div className="card-head">
        <h3>{t('detail.externalTokenTitle')}</h3>
      </div>
      <p className="meta" style={{ marginBottom: 10 }}>
        {t('detail.externalTokenBody')}
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: 1 }}>
          <span>{t('wizard.externalAccessLabel')}</span>
          <input
            className="input num"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoComplete="off"
            type="password"
            data-testid="external-token-input"
          />
        </label>
        <button
          className="btn btn-primary btn-sm"
          onClick={onSubmit}
          disabled={busy}
          data-testid="external-token-update-btn"
        >
          <Icon name="external" />
          {busy ? t('detail.externalTokenUpdating') : t('detail.externalTokenUpdate')}
        </button>
      </div>
    </div>
  )
}
