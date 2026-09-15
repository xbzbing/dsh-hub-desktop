import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { HttpAuthDetection } from '@shared/contracts'
import type { MessageKey } from '@shared/i18n/messages'
import { useAppStore } from '../store'
import { Icon } from '../lib/icons'
import type { IconName } from '../lib/icons'

const BRIDGE = window.dshHub

/**
 * 向导远程分支的「认证模式探测」展示（T6,设计文档 §2.3 / 设计稿 urlDetect）。
 *
 * 粘贴/输入端点后做一次只读探测：

 * - gateway → 提示「检测到登录认证，创建后打开登录面板」
 * - none → 提示可直接访问
 * - browser-auth → 提示由页面内自认证
 * - unreachable → 提示端点当前不可达（仍可创建，连接时重试）
 * 探测不写注册表、不携带凭据。
 */

/** 只放文案 key:模块级表内嵌文案会让双语必然遗漏(由 i18n-coverage.test.ts 钉住) */
const MODE_COPY: Record<
  HttpAuthDetection['mode'],
  { tone: string; icon: IconName; textKey: MessageKey }
> = {
  gateway: { tone: 'n-ok', icon: 'check', textKey: 'detect.gateway' },
  none: { tone: 'n-ok', icon: 'check', textKey: 'detect.none' },
  'browser-auth': { tone: 'n-info', icon: 'shield', textKey: 'detect.browserAuth' },
  unreachable: { tone: 'n-warn', icon: 'alert', textKey: 'detect.unreachable' },
  unknown: { tone: 'n-warn', icon: 'info', textKey: 'detect.unknown' }
}

export default function UrlDetect(props: { endpointUrl: string }): ReactNode {
  const t = useAppStore((state) => state.t)
  const [detection, setDetection] = useState<HttpAuthDetection | null>(null)
  // React 的初始写法:error 是**来自主进程的运行期文案**(如 invalid-input 的说明),
  // 无法表示为 key。本地兜底文案则用 key,避免 effect 依赖 t
  // (否则切换语言会重跑探测)。
  const [error, setError] = useState<string | null>(null)
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const url = props.endpointUrl.trim()

  useEffect(() => {
    if (!BRIDGE || url === '') {
      setDetection(null)
      setError(null)
      setErrorKey(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void BRIDGE.http
        .detect(url)
        .then((result) => {
          if (cancelled) return
          if (result.ok) {
            setDetection(result.value)
            setError(null)
            setErrorKey(null)
      setErrorKey(null)
          } else {
            setDetection(null)
            setError(result.message)
          }
        })
        .catch(() => {
          if (!cancelled) setErrorKey('detect.failed')
        })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [url])

  if (url === '') {
    return (
      <div className="hintbar" data-testid="url-detect-hint">
        <Icon name="link" />
        <span>{t('detect.hint')}</span>
      </div>
    )
  }
  const errorText = error ?? (errorKey === null ? null : t(errorKey))
  if (errorText !== null) {
    return (
      <div className="note n-warn" data-testid="url-detect-error">
        <Icon name="alert" />
        <span>{errorText}</span>
      </div>
    )
  }
  if (!detection) {
    return (
      <div className="hintbar" data-testid="url-detect-loading">
        <Icon name="link" />
        <span>{t('detect.probing')}</span>
      </div>
    )
  }
  const copy = MODE_COPY[detection.mode]
  return (
    <div className={`note ${copy.tone}`} data-testid={`url-detect-${detection.mode}`}>
      <Icon name={copy.icon} />
      <span>
        {t(copy.textKey)}
        <span className="meta"> · {detection.evidence}</span>
      </span>
    </div>
  )
}
