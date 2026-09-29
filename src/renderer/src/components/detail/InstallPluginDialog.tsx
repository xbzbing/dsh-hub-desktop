import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Translator } from '@shared/i18n'
import { Modal } from '../Modal'
import { useAppStore } from '../../store'

/** 安装插件对话框：单一输入框自由填 spec（npm 名 / name@version / github: / file:）。 */
export default function InstallPluginDialog(props: {
  t: Translator
  onClose: () => void
  onSubmit: (spec: string) => Promise<void>
}): ReactNode {
  const { t, onClose, onSubmit } = props
  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState(false)
  const closeLabel = useAppStore((state) => state.t('common.close'))

  const submit = async (): Promise<void> => {
    const value = spec.trim()
    if (value === '' || busy) return
    setBusy(true)
    try {
      await onSubmit(value)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('detail.plugin.installTitle')}
      onClose={onClose}
      closeLabel={closeLabel}
      testId="install-plugin-dialog"
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void submit()}
            disabled={busy || spec.trim() === ''}
            data-testid="install-plugin-submit"
          >
            {busy ? t('detail.plugin.installing') : t('detail.plugin.installSubmit')}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t('detail.plugin.installLabel')}</span>
        <input
          className="input"
          value={spec}
          autoFocus
          placeholder={t('detail.plugin.installPlaceholder')}
          onChange={(event) => setSpec(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
          data-testid="install-plugin-input"
        />
      </label>
      <p className="meta mt8">{t('detail.plugin.installHint')}</p>
    </Modal>
  )
}
