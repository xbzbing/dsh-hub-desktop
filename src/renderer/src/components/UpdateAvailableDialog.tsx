import type { ReactNode } from 'react'
import type { AppUpdateCheck } from '@shared/bridge'
import type { Translator } from '@shared/i18n'
import { Modal } from './Modal'
import MarkdownView from './detail/MarkdownView'

/**
 * 发现新版本时弹出的更新说明。
 *
 * 正文是 GitHub Release 的 Markdown，由主进程截断后随检查结果下发；渲染仍走
 * MarkdownView 的净化链路，正文里的链接交主进程用系统浏览器打开。
 */
export default function UpdateAvailableDialog(props: {
  t: Translator
  update: AppUpdateCheck
  onClose: () => void
  onOpenRelease: () => void
  onOpenLink: (url: string) => void
}): ReactNode {
  const { t, update, onClose, onOpenRelease, onOpenLink } = props
  // 正文通常以 `# vX.Y.Z` 开头，与对话框标题重复，展示时去掉首个一级标题。
  const notes = (update.notes ?? '').replace(/^\s*#\s+[^\n]*\n+/, '')
  const meta =
    update.publishedAt === null
      ? t('settings.updateDialogCurrent', { current: update.current })
      : t('settings.updateDialogMeta', {
          current: update.current,
          date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
            new Date(update.publishedAt)
          )
        })

  return (
    <Modal
      wide
      title={t('settings.updateDialogTitle', { version: update.latest })}
      onClose={onClose}
      closeLabel={t('common.close')}
      testId="update-available-dialog"
      footer={
        <div className="right">
          <button
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            data-testid="update-dialog-close"
          >
            {t('common.close')}
          </button>
          {update.releaseUrl !== null && (
            <button
              className="btn btn-primary btn-sm"
              onClick={onOpenRelease}
              data-testid="update-dialog-release"
            >
              {t('settings.updateOpenRelease')}
            </button>
          )}
        </div>
      }
    >
      <p className="meta" data-testid="update-dialog-meta">
        {meta}
      </p>
      <div className="mt12" data-testid="update-dialog-notes">
        {notes.trim() === '' ? (
          <p className="meta">{t('settings.updateDialogNoNotes')}</p>
        ) : (
          <MarkdownView source={notes} openLink={onOpenLink} />
        )}
      </div>
    </Modal>
  )
}
