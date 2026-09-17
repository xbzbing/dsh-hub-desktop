import { useEffect, useLayoutEffect, useRef } from 'react'
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
import WorkspaceToolbar from './components/WorkspaceToolbar'

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
  const workspaceOpen = useAppStore((state) => state.workspaceOpen)
  const contentRef = useRef<HTMLElement | null>(null)
  const workspaceToolbarRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!BRIDGE) return
    void useAppStore.getState().load()
    // 状态事件 → store(主进程 → preload → 渲染,唯一状态推进来源)
    const unsubscribeStatus = BRIDGE.onInstanceStatus((event) =>
      useAppStore.getState().applyStatus(event)
    )
    // 认证相位写入 store；应用级订阅确保详情按钮收到状态更新。
    const unsubscribeAuth = BRIDGE.auth.onState((event) =>
      useAppStore.getState().applyAuthPhase(event.instanceId, event.state.phase)
    )
    return () => {
      unsubscribeStatus()
      unsubscribeAuth()
    }
  }, [])

  useLayoutEffect(() => {
    if (!workspaceOpen || !contentRef.current) return
    const element = contentRef.current
    const toolbar = workspaceToolbarRef.current
    const updateBounds = (): void => {
      const rect = element.getBoundingClientRect()
      const toolbarHeight = toolbar?.getBoundingClientRect().height ?? 0
      void window.dshHub?.runtime.updateViewBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top + toolbarHeight),
        width: Math.round(rect.width),
        height: Math.max(0, Math.round(rect.height - toolbarHeight))
      })
    }
    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    observer.observe(element)
    if (toolbar) observer.observe(toolbar)
    window.addEventListener('resize', updateBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
    }
  }, [workspaceOpen, rail])
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
  const selectedInstance = selection ? instances.find((instance) => instance.id === selection) : undefined
  const title = t('nav.overview')

  return (
    <div className={`app-shell${rail ? ' rail' : ''}`} data-testid="app-shell">
      {/* 顶栏横跨侧边栏和主区，为 macOS 窗口控件预留空间。 */}
      <div className="topbar">
        <div className="tb-left">
          <span className="tb-title" data-testid="tb-title">
            {settingsOpen
              ? t('settings.title')
              : workspaceOpen && selectedInstance
                ? selectedInstance.name
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
      <main ref={contentRef} className={`content${workspaceOpen ? ' workspace-active' : ''}`}>
        {workspaceOpen && <WorkspaceToolbar ref={workspaceToolbarRef} />}
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