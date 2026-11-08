import { useState } from 'react'
import type { ReactNode } from 'react'
import type { InstanceRecord, ProxyType } from '@shared/contracts'
import { Icon } from '../../lib/icons'
import { localizeIpcMessage } from '../../lib/ipc-message'
import {
  buildProxyPatch,
  proxyDraftOf,
  switchProxyType,
  type ProxyDraft
} from '../../lib/proxy-form'
import { useAppStore } from '../../store'
import { Modal } from '../Modal'
import Select from '../Select'

/**
 * 只编辑代理的对话框：入口在「连接方式」卡的代理行，不必为改一个代理打开整套实例编辑。
 *
 * 保存后实例记录与分区 session 的代理同时更新；该实例若已有缓存的工作区视图，
 * 就地重新导航一次（不切走当前详情页），新代理才会对页面生效。
 */
export default function ProxyDialog({
  record,
  onClose
}: {
  record: InstanceRecord
  onClose: () => void
}): ReactNode {
  const t = useAppStore((state) => state.t)
  const refreshList = useAppStore((state) => state.refreshList)
  const reloadRecord = useAppStore((state) => state.reloadRecord)
  const workspaceConnected = useAppStore((state) => state.workspaceConnected[record.id] ?? false)
  const toast = useAppStore((state) => state.toast)

  const existingProxy = record.transport === 'http' ? (record.proxy ?? null) : null
  const [draft, setDraft] = useState<ProxyDraft>(() => proxyDraftOf(existingProxy))
  const [busy, setBusy] = useState(false)

  const set =
    (key: 'host' | 'port' | 'username' | 'password') =>
    (event: { target: { value: string } }): void => {
      setDraft((current) => ({ ...current, [key]: event.target.value }))
    }

  const save = async (): Promise<void> => {
    const built = buildProxyPatch(draft, existingProxy)
    if (!built.ok) {
      toast('err', t('edit.failed'), t(built.messageKey))
      return
    }
    setBusy(true)
    const result = await window.dshHub?.instances.update(record.id, { proxy: built.proxy })
    setBusy(false)
    if (result && !result.ok) {
      toast('err', t('edit.failed'), localizeIpcMessage(t, result.message))
      return
    }
    await Promise.all([refreshList(), reloadRecord(record.id)])
    toast('ok', t('detail.proxySaved'))
    onClose()
    // 代理已在主进程落到该实例分区；已缓存的工作区就地重新导航（不切走当前详情页），
    // 否则它仍停在使用旧代理时的页面上。
    if (workspaceConnected) void window.dshHub?.runtime.reloadView(record.id)
  }

  return (
    <Modal
      title={t('detail.editProxy')}
      sub={t('detail.editProxySub', { name: record.name })}
      onClose={onClose}
      testId="proxy-dialog"
      closeLabel={t('common.close')}
      footer={
        <div className="right">
          <button className="btn btn-secondary btn-sm" onClick={onClose} data-testid="proxy-cancel">
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void save()}
            disabled={busy}
            data-testid="proxy-save"
          >
            <Icon name="check" /> {t('common.save')}
          </button>
        </div>
      }
    >
      <div className="field">
        <label htmlFor="proxy-dialog-type">{t('edit.proxyTypeLabel')}</label>
        <Select
          id="proxy-dialog-type"
          value={draft.type}
          onChange={(value) =>
            setDraft((current) => switchProxyType(current, value as ProxyType | 'none'))
          }
          options={[
            { value: 'none', label: t('wizard.proxyNone') },
            { value: 'http', label: t('wizard.proxyHttp') },
            { value: 'socks5', label: t('wizard.proxySocks5') }
          ]}
          testId="proxy-dialog-type"
        />
        <span className="hint">{t('detail.editProxyHint')}</span>
      </div>

      {draft.type !== 'none' && (
        <>
          <div className="grid-2 mt8">
            <div className="field">
              <label htmlFor="proxy-dialog-host">{t('wizard.proxyHostLabel')}</label>
              <input
                className="input num"
                id="proxy-dialog-host"
                placeholder="127.0.0.1"
                value={draft.host}
                onChange={set('host')}
                data-testid="proxy-dialog-host"
              />
            </div>
            <div className="field">
              <label htmlFor="proxy-dialog-port">{t('wizard.proxyPortLabel')}</label>
              <input
                className="input num"
                id="proxy-dialog-port"
                inputMode="numeric"
                placeholder="8080"
                value={draft.port}
                onChange={set('port')}
                data-testid="proxy-dialog-port"
              />
            </div>
            {draft.type === 'http' && (
              <>
                <div className="field">
                  <label htmlFor="proxy-dialog-username">{t('wizard.proxyUsernameLabel')}</label>
                  <input
                    className="input"
                    id="proxy-dialog-username"
                    autoComplete="off"
                    value={draft.username}
                    onChange={set('username')}
                    data-testid="proxy-dialog-username"
                  />
                </div>
                <div className="field">
                  <label htmlFor="proxy-dialog-password">{t('wizard.proxyPasswordLabel')}</label>
                  <input
                    className="input"
                    id="proxy-dialog-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={t('edit.proxyPasswordKeep')}
                    value={draft.password}
                    onChange={(event) => {
                      const value = event.target.value
                      setDraft((current) => ({
                        ...current,
                        password: value,
                        ...(value !== '' ? { clearPassword: false } : {})
                      }))
                    }}
                    data-testid="proxy-dialog-password"
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
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    clearPassword: event.target.checked,
                    ...(event.target.checked ? { password: '' } : {})
                  }))
                }
                data-testid="proxy-dialog-clear-password"
              />
              <span>{t('edit.proxyClearPassword')}</span>
            </label>
          )}
          <p className="meta mt8">{t('edit.proxyPasswordHint')}</p>
        </>
      )}
    </Modal>
  )
}
