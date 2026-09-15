import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SshKeyPreviewResult } from '@shared/contracts'
import { Icon } from '../lib/icons'

const BRIDGE = window.dshHub

/**
 * 向导 Step2 的「将使用哪个密钥」只读预览（设计稿 keyPreview / 设计文档 §4.2）。
 *
 * 三态：
 * - 未填主机 → 提示条；
 * - 解析出私钥或 agent 有可用密钥 → 绿色说明（agent 优先，其次 config/default 路径）；
 * - agent 未运行/为空且无解析出的密钥 → 警示 + 引导。
 * **只展示路径与公钥元信息，绝不读取/展示私钥内容。**
 */
export default function KeyPreview(props: {
  host: string
  username: string
  sshPort: string
}): ReactNode {
  const [preview, setPreview] = useState<SshKeyPreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const host = props.host.trim()
  const username = props.username.trim()
  const port = Number(props.sshPort) || 22

  useEffect(() => {
    if (!BRIDGE || host === '' || username === '') {
      setPreview(null)
      setError(null)
      return
    }
    let cancelled = false
    // 输入停顿后再解析,避免每次按键都派生 ssh -G / ssh-add
    const timer = setTimeout(() => {
      void BRIDGE.ssh
        .keyPreview({ host, port, username })
        .then((result) => {
          if (cancelled) return
          if (result.ok) {
            setPreview(result.value)
            setError(null)
          } else {
            setPreview(null)
            setError(result.message)
          }
        })
        .catch(() => {
          if (!cancelled) setError('密钥解析失败')
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [host, username, port])

  if (host === '') {
    return (
      <div className="hintbar" data-testid="key-preview-hint">
        <Icon name="key" />
        <span>填写主机后会自动展示将使用哪个密钥。</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="note n-warn" data-testid="key-preview-error">
        <Icon name="alert" />
        <span>{error}</span>
      </div>
    )
  }

  if (!preview) {
    return (
      <div className="hintbar" data-testid="key-preview-loading">
        <Icon name="key" />
        <span>正在解析将使用的密钥…</span>
      </div>
    )
  }

  const agentReady = preview.agent.status === 'ready'
  const agentKey = preview.agent.keys[0]
  const firstIdentity = preview.identityFiles[0]
  const hasUsableKey = agentReady || preview.identityFiles.length > 0

  if (!hasUsableKey) {
    return (
      <div className="note n-warn" data-testid="key-preview-empty">
        <Icon name="alert" />
        <span>
          未检测到可用密钥（agent {preview.agent.status === 'unavailable' ? '未运行' : '为空'}，
          也没有解析到默认私钥）。请启动 ssh-agent 并加载密钥，或改用密码认证。
        </span>
      </div>
    )
  }

  return (
    <div className="note n-ok" data-testid="key-preview-ok">
      <Icon name="key" />
      <span>
        将使用密钥：
        <span className="num">
          {agentReady && agentKey
            ? `${agentKey.typeLabel} (ssh-agent${agentKey.comment ? ` · ${agentKey.comment}` : ''})`
            : (firstIdentity ?? '默认私钥')}
        </span>
        {preview.identityFiles.length > 1 && (
          <span className="meta"> · 备用 {preview.identityFiles.length - 1} 把</span>
        )}
        {preview.explicitIdentityFile && <span className="meta"> · 实例已指定私钥</span>}
      </span>
    </div>
  )
}