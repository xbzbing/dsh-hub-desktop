import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { HttpAuthDetection } from '@shared/contracts'
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

const MODE_COPY: Record<
  HttpAuthDetection['mode'],
  { tone: string; icon: IconName; text: string }
> = {
  gateway: { tone: 'n-ok', icon: 'check', text: '已识别登录认证（密码 + 动态验证码），创建后打开登录面板' },
  none: { tone: 'n-ok', icon: 'check', text: '无需登录认证，可直接访问' },
  'browser-auth': { tone: 'n-info', icon: 'shield', text: '检测到 dsh 内置浏览器认证，将在实例页面内自认证' },
  unreachable: { tone: 'n-warn', icon: 'alert', text: '端点当前不可达；仍可创建，连接时会自动重试' },
  unknown: { tone: 'n-warn', icon: 'info', text: '未能识别认证模式；连接时再判定' }
}

export default function UrlDetect(props: { endpointUrl: string }): ReactNode {
  const [detection, setDetection] = useState<HttpAuthDetection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const url = props.endpointUrl.trim()

  useEffect(() => {
    if (!BRIDGE || url === '') {
      setDetection(null)
      setError(null)
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
          } else {
            setDetection(null)
            setError(result.message)
          }
        })
        .catch(() => {
          if (!cancelled) setError('探测失败')
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
        <span>粘贴完整网址后自动识别是否需要登录。</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="note n-warn" data-testid="url-detect-error">
        <Icon name="alert" />
        <span>{error}</span>
      </div>
    )
  }
  if (!detection) {
    return (
      <div className="hintbar" data-testid="url-detect-loading">
        <Icon name="link" />
        <span>正在探测端点…</span>
      </div>
    )
  }
  const copy = MODE_COPY[detection.mode]
  return (
    <div className={`note ${copy.tone}`} data-testid={`url-detect-${detection.mode}`}>
      <Icon name={copy.icon} />
      <span>
        {copy.text}
        <span className="meta"> · {detection.evidence}</span>
      </span>
    </div>
  )
}
