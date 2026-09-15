import { useEffect } from 'react'
import { useAppStore } from './store'
import Sidebar from './components/Sidebar'
import HomeView from './components/HomeView'
import EmptyView from './components/EmptyView'
import DetailView from './components/DetailView'
import Wizard from './components/Wizard'
import Toasts from './components/Toasts'

const BRIDGE = window.dshHub

/**
 * 应用外壳：侧边栏 + 主内容区 + 浮层。
 * 视图路由：首载骨架 → 空态 / 总览表格 / 实例详情；向导与 Toast 为全局浮层。
 */
export default function App() {
  const loaded = useAppStore((state) => state.loaded)
  const instances = useAppStore((state) => state.instances)
  const selection = useAppStore((state) => state.selection)
  const rail = useAppStore((state) => state.rail)
  const wizardOpen = useAppStore((state) => state.wizardOpen)
  const toggleRail = useAppStore((state) => state.toggleRail)
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  const statuses = useAppStore((state) => state.statuses)

  useEffect(() => {
    if (!BRIDGE) return
    void useAppStore.getState().load()
    // 状态事件 → store(主进程 → preload → 渲染,唯一状态推进来源)
    const unsubscribe = BRIDGE.onInstanceStatus((event) => useAppStore.getState().applyStatus(event))
    return unsubscribe
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
  const title = selection ? undefined : '实例工作台'

  return (
    <div className={`app-shell${rail ? ' rail' : ''}`} data-testid="app-shell">
      <Sidebar />
      <main className="content">
        <div className="topbar">
          <div className="tb-left">
            <span className="tb-title" data-testid="tb-title">
              {selection ? '实例详情' : title}
            </span>
            <span className="tb-sub" data-testid="tb-sub">
              {selectedStatus?.detail ?? `${instances.length} 个实例`}
            </span>
          </div>
        </div>
        <div className="content-scroll" data-testid="content-scroll">
          {selection !== null && loaded ? (
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
      <Toasts />
    </div>
  )
}