import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { Icon } from '../lib/icons'

const BRIDGE = window.dshHub

/** macOS 的 ⌘F 与其它平台的 Ctrl+F；Alt 组合留给页面自身。 */
function isFindShortcut(event: KeyboardEvent): boolean {
  if (event.altKey || event.key.toLowerCase() !== 'f') return false
  return event.metaKey || event.ctrlKey
}

/**
 * 顶栏页内查找条。
 *
 * 工作区是主进程的 WebContentsView，DOM 浮层会被它整块盖住；顶栏在视图边界之外，
 * 因此查找 UI 放在顶栏右侧，输入与结果计数不会遮挡页面内容。
 */
export default function WorkspaceFind(): React.ReactNode {
  const t = useAppStore((state) => state.t)
  const selection = useAppStore((state) => state.selection)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [composing, setComposing] = useState(false)
  const [result, setResult] = useState<{ active: number; matches: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const openRef = useRef(false)

  const reset = useCallback(() => {
    setOpen(false)
    setQuery('')
    setComposing(false)
    setResult(null)
  }, [])

  const focusInput = useCallback(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const openBar = useCallback(() => {
    setOpen(true)
    // 已在打开态时再次按 ⌘F 也要把焦点抢回输入框并全选。
    requestAnimationFrame(focusInput)
  }, [focusInput])

  const close = useCallback(() => {
    reset()
    void BRIDGE?.runtime.stopFindInPage({ focusView: true })
  }, [reset])

  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    // 菜单快捷键从原生工作区夺回焦点后，等 DOM 提交完成再聚焦输入框。
    const frame = requestAnimationFrame(focusInput)
    return () => cancelAnimationFrame(frame)
  }, [open, focusInput])

  useEffect(() => {
    if (!BRIDGE) return
    const offRequest = BRIDGE.onFindRequest((request) => {
      if (request.action === 'open') openBar()
      else reset()
    })
    const offResult = BRIDGE.onFindResult((payload) => {
      if (!openRef.current) return
      setResult({ active: payload.activeMatchOrdinal, matches: payload.matches })
    })
    return () => {
      offRequest()
      offResult()
    }
  }, [openBar, reset])

  // 切换实例时旧页面的查找会话已作废：收起面板，避免把查询带到新工作区。
  useEffect(() => {
    reset()
  }, [selection, reset])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isFindShortcut(event)) return
      event.preventDefault()
      openBar()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openBar])

  useEffect(() => {
    if (!open || composing) return
    if (query === '') {
      setResult(null)
      // 清空输入只撤销高亮，不把焦点从输入框抢回工作区。
      void BRIDGE?.runtime.stopFindInPage({ focusView: false })
      return
    }
    // 新查询的结果到达前先清掉旧计数，避免短暂显示上一串查询的命中数。
    setResult(null)
    void BRIDGE?.runtime.findInPage({ query, forward: true, findNext: false })
  }, [open, query, composing])

  const step = (forward: boolean): void => {
    if (query === '') return
    void BRIDGE?.runtime.findInPage({ query, forward, findNext: true })
  }

  if (!open) return null

  const count =
    query === '' || result === null
      ? ''
      : result.matches > 0
        ? `${result.active}/${result.matches}`
        : t('find.noResults')

  return (
    <div
      className="find-bar"
      role="search"
      aria-label={t('find.label')}
      data-testid="workspace-find"
    >
      <Icon name="search" size={14} className="find-icon" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            step(!event.shiftKey)
          }
        }}
        placeholder={t('find.placeholder')}
        aria-label={t('find.label')}
        maxLength={200}
        spellCheck={false}
        data-testid="workspace-find-input"
      />
      <span className="find-count" aria-live="polite" data-testid="workspace-find-count">
        {count}
      </span>
      <button
        className="find-step"
        onClick={() => step(false)}
        disabled={query === ''}
        title={t('find.previous')}
        aria-label={t('find.previous')}
        data-testid="workspace-find-prev"
      >
        <Icon name="chevron-up" size={14} />
      </button>
      <button
        className="find-step"
        onClick={() => step(true)}
        disabled={query === ''}
        title={t('find.next')}
        aria-label={t('find.next')}
        data-testid="workspace-find-next"
      >
        <Icon name="chevron-down" size={14} />
      </button>
      <button
        className="find-step find-close"
        onClick={close}
        title={t('find.close')}
        aria-label={t('find.close')}
        data-testid="workspace-find-close"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
