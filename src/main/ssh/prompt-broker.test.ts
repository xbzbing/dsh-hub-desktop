import { describe, expect, it, vi } from 'vitest'
import { createPromptBroker } from './prompt-broker'

function makeBroker() {
  const sent: Array<{ channel: string; payload: { requestId: string } }> = []
  const broker = createPromptBroker({
    send: (channel, payload) => sent.push({ channel, payload: payload as { requestId: string } }),
    hostKeyTimeoutMs: 50,
    askpassTimeoutMs: 50
  })
  return { broker, sent }
}

describe('prompt-broker（用户提示代理）', () => {
  it('指纹确认:投递带 requestId 的事件,回答后 resolve', async () => {
    const { broker, sent } = makeBroker()
    const promise = broker.requestHostKey({
      instanceId: 'i1',
      target: 'h:22',
      verdict: 'unknown',
      fingerprints: [],
      previousFingerprints: []
    })
    expect(sent[0]?.channel).toBe('ssh:hostKeyDecision')
    const requestId = sent[0]?.payload.requestId ?? ''
    expect(broker.replyHostKey(requestId, 'trust')).toBe(true)
    await expect(promise).resolves.toBe('trust')
    // 重复回答无效
    expect(broker.replyHostKey(requestId, 'reject')).toBe(false)
  })

  it('指纹确认:超时/无应答 → 默认拒绝（绝不默认信任）', async () => {
    const { broker } = makeBroker()
    await expect(
      broker.requestHostKey({
        instanceId: 'i1',
        target: 'h',
        verdict: 'changed',
        fingerprints: [],
        previousFingerprints: []
      })
    ).resolves.toBe('reject')
  })

  it('口令:回答后 resolve 明文;取消返回 null', async () => {
    const { broker, sent } = makeBroker()
    const promise = broker.requestAskpass({ instanceId: 'i1', prompt: 'Enter passphrase:' })
    expect(sent[0]?.channel).toBe('ssh:askpassRequest')
    const requestId = sent[0]?.payload.requestId ?? ''
    expect(broker.replyAskpass(requestId, 's3cret')).toBe(true)
    await expect(promise).resolves.toBe('s3cret')

    const cancelled = broker.requestAskpass({ instanceId: 'i1', prompt: 'p' })
    const id2 = sent[1]?.payload.requestId ?? ''
    broker.replyAskpass(id2, null)
    await expect(cancelled).resolves.toBeNull()
  })

  it('口令:超时 → null（不挂起隧道启动）', async () => {
    const { broker } = makeBroker()
    await expect(broker.requestAskpass({ instanceId: 'i1', prompt: 'p' })).resolves.toBeNull()
  })

  it('cancelAll(窗口关闭/退出):所有待答请求立即收敛', async () => {
    const { broker } = makeBroker()
    const hostKey = broker.requestHostKey({
      instanceId: 'i1',
      target: 'h',
      verdict: 'unknown',
      fingerprints: [],
      previousFingerprints: []
    })
    const askpass = broker.requestAskpass({ instanceId: 'i1', prompt: 'p' })
    broker.cancelAll()
    await expect(hostKey).resolves.toBe('reject')
    await expect(askpass).resolves.toBeNull()
  })

  it('口令不经日志:broker 不持有任何持久化句柄(仅内存 Map)', () => {
    const { broker } = makeBroker()
    const spy = vi.spyOn(console, 'log')
    void broker.requestAskpass({ instanceId: 'i1', prompt: 'p' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
