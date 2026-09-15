import { useEffect, useState } from 'react'
import type { AppInfo, PingResult } from '@shared/bridge'

const BRIDGE = window.dshHub

/**
 * T1 骨架占位视图：验证 主进程 ⇄ preload ⇄ React 渲染 全链路。
 * T3 起由 `view-home` / `view-empty` 等真实视图替换（设计稿 data-od-id 一一对应）。
 */
export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [bridgeError, setBridgeError] = useState<string | null>(null)
  const [pong, setPong] = useState<PingResult | null>(null)

  useEffect(() => {
    if (!BRIDGE) {
      setBridgeError('preload 未注入 dshHub 桥接：请确认以 Electron 启动，而不是纯浏览器打开')
      return
    }
    BRIDGE.getInfo()
      .then((result) => {
        if (result.ok) setInfo(result.value)
        else setBridgeError(result.message)
      })
      .catch((error: unknown) => setBridgeError(String(error)))
  }, [])

  useEffect(() => {
    if (info) document.documentElement.dataset.platform = info.platform
  }, [info])

  const runPing = async (): Promise<void> => {
    if (!BRIDGE) return
    try {
      const result = await BRIDGE.ping('hello from renderer')
      if (result.ok) setPong(result.value)
      else setBridgeError(result.message)
    } catch (error) {
      setBridgeError(String(error))
    }
  }

  return (
    <div className="shell" data-testid="app-shell">
      <header className="titlebar">
        <span className="titlebar-title num">DSH Hub · 骨架 (T1)</span>
      </header>
      <div className="app-body">
        <aside className="rail" data-testid="rail" aria-label="侧边栏">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>
          <span className="brand-name">DSH Hub</span>
          <span className="brand-sub">实例管理</span>
        </aside>
        <main className="content" data-testid="content">
          <div className="card">
            <p className="eyebrow">仓库脚手架 · T1</p>
            <h1>DSH Hub 骨架就绪</h1>
            <p className="lead">
              Electron 三端（main / preload / renderer）已联通。下面的版本信息来自主进程，
              由 preload 白名单桥接注入 —— 三端链路正常时才会出现。
            </p>

            {info ? (
              <p className="versions num" data-testid="versions">
                app {info.appVersion} · electron {info.electron} · chrome {info.chrome} · node{' '}
                {info.node} · {info.platform}/{info.arch}
              </p>
            ) : (
              <p className="versions num muted" data-testid="versions">
                {bridgeError ? '—— 桥接异常' : '正在读取版本信息…'}
              </p>
            )}
            {bridgeError && <p className="warn" data-testid="bridge-error">{bridgeError}</p>}

            <div className="actions">
              <button type="button" data-testid="ping-button" onClick={() => void runPing()} disabled={!BRIDGE}>
                测试 IPC ping
              </button>
              {pong && (
                <p className="pong num" data-testid="pong-status">
                  pong · echo={pong.echo ?? '(空)'} · at={pong.at}
                </p>
              )}
            </div>

            <p className="meta">数据目录：{info?.userDataPath ?? '…'}</p>
          </div>
        </main>
      </div>
    </div>
  )
}