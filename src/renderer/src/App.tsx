import { useEffect } from 'react'
import { useAppStore } from './store'
import Sidebar from './components/Sidebar'
import HomeView from './components/HomeView'
import EmptyView from './components/EmptyView'
import DetailView from './components/DetailView'
import Wizard from './components/Wizard'
import Toasts from './components/Toasts'
import SshDialogs from './components/SshDialogs'
import AuthPanel from './components/AuthPanel'
import SettingsView from './components/SettingsView'

const BRIDGE = window.dshHub

/**
 * 应用外壳：侧边栏 + 主内容区 + 浮层。
 * 视图路由：首载骨架 → 空态 / 总览表格 / 实例详情；向导与 Toast 为全局浮层。
 */
export default function App() {
  const loaded = useAppStore((state) => state.loaded)
  const instances = useAppStore((state) => state.instances)
  const selection = useAppStore((state) => state.selection)
  const settingsOpen = useAppStore((state) => state.settingsOpen)
  const t = useAppStore((state) => state.t)
  const rail = useAppStore((state) => state.rail)
  const wizardOpen = useAppStore((state) => state.wizardOpen)
  const toggleRail = useAppStore((state) => state.toggleRail)
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  const statuses = useAppStore((state) => state.statuses)

  useEffect(() => {
    if (!BRIDGE) return
    void useAppStore.getState().load()
    // 状态事件 → store(主进程 → preload → 渲染,唯一状态推进来源)
    const unsubscribeStatus = BRIDGE.onInstanceStatus((event) =>
      useAppStore.getState().applyStatus(event)
    )
    // 认证相位 → store(#2:详情页按钮状态化的数据源;App 级订阅保证事件不漏)
    const unsubscribeAuth = BRIDGE.auth.onState((event) =>
      useAppStore.getState().applyAuthPhase(event.instanceId, event.state.phase)
    )
    return () => {
      unsubscribeStatus()
      unsubscribeAuth()
    }
  }, [])

  // 快捷键:⌘N 新建实例 · ⌘B 折叠侧栏
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) return
      if (event.key === 'n') {
        event.preventDefault()
        setWizardOpen(true)
      } else if (event.key === 'b') {
        event.preventDefault()
        toggleRail()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setWizardOpen, toggleRail])

  const selectedStatus = selection ? statuses[selection] : undefined
  const title = t('nav.overview')

  return (
    <div className={`app-shell${rail ? ' rail' : ''}`} data-testid="app-shell">
      {/* 用户反馈 #4:顶栏(工作区标题栏)提升为全宽统一标题栏,横跨 sidebar 与主区 ——
          macOS 红绿灯落在顶栏带内,sidebar 边框不再直达窗口顶部 */}
      <div className="topbar">
        <div className="tb-left">
          <span className="tb-title" data-testid="tb-title">
            {settingsOpen
              ? t('settings.title')
              : selection
                ? t('detail.instanceDetail')
                : title}
          </span>
          <span className="tb-sub" data-testid="tb-sub">
            {selectedStatus?.detail ?? t('nav.instanceCount', { n: instances.length })}
          </span>
        </div>
      </div>
      <Sidebar />
      <main className="content">
        <div className="content-scroll" data-testid="content-scroll">
          {settingsOpen ? (
            <SettingsView />
          ) : selection !== null && loaded ? (
            <DetailView />
          ) : !loaded ? (
            <HomeView />
          ) : instances.length === 0 ? (
            <EmptyView />
          ) : (
            <HomeView />
          )}
        </div>
      </main>
      {wizardOpen && <Wizard />}
      <SshDialogs />
      <AuthPanel />
      <Toasts />
    </div>
  )
}