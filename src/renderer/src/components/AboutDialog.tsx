import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/bridge'
import { useAppStore } from '../store'
import { Modal } from './Modal'

const BRIDGE = window.dshHub

/**
 * 「关于」面板：应用版本、项目主页链接与运行组件版本。
 *
 * 打开入口是应用菜单（主进程经 `about:open` 广播），因此面板自身订阅该事件；
 * 版本信息取自主进程 `app:info` 快照——渲染层拿不到的东西（Electron/Chromium/Node/V8）
 * 只有主进程能诚实回答。
 */
export default function AboutDialog() {
  const aboutOpen = useAppStore((state) => state.aboutOpen)
  const setAboutOpen = useAppStore((state) => state.setAboutOpen)
  const t = useAppStore((state) => state.t)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    if (!BRIDGE) return
    return BRIDGE.onAboutOpen(() => setAboutOpen(true))
  }, [setAboutOpen])

  useEffect(() => {
    if (!aboutOpen) return
    let cancelled = false
    void BRIDGE?.getInfo().then((result) => {
      if (!cancelled && result.ok) setInfo(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [aboutOpen])

  if (!aboutOpen) return null

  const components: Array<[string, string]> = info
    ? [
        ['Electron', info.electron],
        ['Chromium', info.chrome],
        ['Node.js', info.node],
        ['V8', info.v8]
      ]
    : []

  return (
    <Modal
      title={t('about.title')}
      onClose={() => setAboutOpen(false)}
      closeLabel={t('common.close')}
      initialFocus="dialog"
      testId="about-dialog"
    >
      <div className="about">
        <p className="about-version" data-testid="about-version">
          DSH Hub {info ? `v${info.appVersion}` : ''}
        </p>
        <button
          className="about-homepage"
          data-testid="about-homepage"
          onClick={() => void BRIDGE?.openHomepage()}
        >
          {t('about.homepage')} ↗
        </button>
        <section className="about-components">
          <h3>{t('about.components')}</h3>
          <dl>
            {components.map(([name, version]) => (
              <div key={name} className="about-row">
                <dt>{name}</dt>
                <dd data-testid={`about-${name.toLowerCase()}`}>{version}</dd>
              </div>
            ))}
          </dl>
        </section>
        <p className="about-copyright">{t('about.copyright')}</p>
      </div>
    </Modal>
  )
}
