import type { ReactNode } from 'react'
import { useAppStore } from '../store'
import { Modal } from './Modal'

/** 删除确认弹窗：总览与详情共用同一套标题、页脚、不可撤销提示与回收站勾选。 */
export function DeleteConfirmModal(props: {
  testId: string
  name: string
  /** 仅本机实例且未使用默认空间时才提供「同时回收空间」勾选。 */
  showTrashSpace: boolean
  trashSpace: boolean
  onTrashSpaceChange: (checked: boolean) => void
  /** 关闭与取消同一语义：调用方负责复位自己的弹窗状态与勾选。 */
  onClose: () => void
  onConfirm: () => void
}): ReactNode {
  const t = useAppStore((state) => state.t)
  return (
    <Modal
      closeLabel={t('common.close')}
      title={t('detail.deleteTitle')}
      onClose={props.onClose}
      testId={props.testId}
      footer={
        <>
          <span className="meta">{t('detail.deleteCannotUndo')}</span>
          <div className="right">
            <button className="btn btn-secondary btn-sm" onClick={props.onClose}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger btn-sm" onClick={props.onConfirm}>
              {t('detail.delete')}
            </button>
          </div>
        </>
      }
    >
      <p className="meta">{t('detail.deleteConfirm', { name: props.name })}</p>
      {props.showTrashSpace && (
        <label className="check mt12">
          <input
            type="checkbox"
            checked={props.trashSpace}
            onChange={(event) => props.onTrashSpaceChange(event.target.checked)}
          />
          {t('detail.deleteSpace')}
        </label>
      )}
    </Modal>
  )
}
