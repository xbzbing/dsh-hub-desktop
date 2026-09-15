import { connect } from 'node:net'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ASKPASS_HELPER_NAME,
  ASKPASS_WRAPPER_NAME,
  askpassSocketPath,
  askpassWrapperSource,
  ensureAskpassScripts,
  startAskpassServer
} from './askpass'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-askpass-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 用真实 socket 走一遍 helper 侧协议 */
function askpassRoundTrip(socketPath: string, prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.write(`${JSON.stringify({ prompt })}\n`)
    })
    let buffer = ''
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const index = buffer.indexOf('\n')
      if (index === -1) return
      client.end()
      resolve(buffer.slice(0, index))
    })
    client.on('error', reject)
  })
}

describe('askpass（T5 口令通道）', () => {
  it('runtime 写入 helper + 包装脚本,权限收紧,argv 不经 shell', async () => {
    const scripts = await ensureAskpassScripts(dir, '/usr/bin/node', ['--no-warnings'])
    expect(scripts.wrapperPath.endsWith(ASKPASS_WRAPPER_NAME)).toBe(true)
    expect(scripts.helperPath.endsWith(ASKPASS_HELPER_NAME)).toBe(true)
    const helper = await readFile(scripts.helperPath, 'utf8')
    expect(helper).toContain('DSH_HUB_ASKPASS_SOCKET')
    // 口令只写 stdout
    expect(helper).toContain('finish(0, reply.secret')
    const wrapper = await readFile(scripts.wrapperPath, 'utf8')
    expect(wrapper.startsWith('#!/bin/sh')).toBe(true)
    expect(wrapper).toContain("'/usr/bin/node' '--no-warnings'")
    expect((await stat(scripts.wrapperPath)).mode & 0o777).toBe(0o700)
  })

  it('包装脚本对含空格/单引号的路径做转义', () => {
    const source = askpassWrapperSource('/Applications/DSH Hub/electron', [], "/tmp/it's/helper.cjs")
    expect(source).toContain(`'/Applications/DSH Hub/electron'`)
    expect(source).toContain(`'/tmp/it'\\''s/helper.cjs'`)
  })

  it('socket 协议:提示语送达 → 答案回传(与 helper 同格式)', async () => {
    const socketPath = join(dir, 'ap.sock')
    const seen: string[] = []
    const server = await startAskpassServer({
      socketPath,
      onPrompt: async ({ prompt }) => {
        seen.push(prompt)
        return 'super-secret'
      }
    })
    const reply = await askpassRoundTrip(socketPath, 'Enter passphrase for key:')
    expect(seen).toEqual(['Enter passphrase for key:'])
    expect(JSON.parse(reply)).toEqual({ secret: 'super-secret' })
    // socket 权限 0600
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600)
    await server.close()
  })

  it('用户取消 → {cancelled:true}（ssh 侧鉴权失败并走归因）', async () => {
    const socketPath = join(dir, 'ap2.sock')
    const server = await startAskpassServer({ socketPath, onPrompt: async () => null })
    const reply = await askpassRoundTrip(socketPath, 'Password:')
    expect(JSON.parse(reply)).toEqual({ cancelled: true })
    await server.close()
  })

  it('onPrompt 抛错 → 收敛为取消,不悬挂', async () => {
    const socketPath = join(dir, 'ap3.sock')
    const server = await startAskpassServer({
      socketPath,
      onPrompt: async () => {
        throw new Error('对话框崩溃')
      }
    })
    const reply = await askpassRoundTrip(socketPath, 'Password:')
    expect(JSON.parse(reply)).toEqual({ cancelled: true })
    await server.close()
  })

  it('askpassSocketPath 生成短路径(不触发 unix socket 104 字节上限)', () => {
    const path = askpassSocketPath('/var/folders/x/T/dsh-hub-ssh-12345678', 'f47ac10b58cc')
    expect(path).toBe('/var/folders/x/T/dsh-hub-ssh-12345678/ap-f47ac10b58cc.sock')
    expect(path.length).toBeLessThan(104)
  })
})
