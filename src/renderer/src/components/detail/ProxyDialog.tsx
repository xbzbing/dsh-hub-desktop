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
import ProxyFields from '../ProxyFields'
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

      <ProxyFields
        t={t}
        draft={draft}
        existingProxy={existingProxy}
        idPrefix="proxy-dialog"
        onChange={setDraft}
      />
    </Modal>
  )
}
