import { describe, expect, it } from 'vitest'
import {
  createExternalDshScanner,
  isDshWebCommand,
  parseDshWebProcesses,
  parseListeningPorts,
  patchOf,
  portOf
} from './external-dsh'

/**
 * 实机反馈(2026-09-16):用户用 dush patch 常驻一个 dsh web
 *   node ~/.local/bin/dsh web --patch ~/.dush/cordis.dush.patch.yml --no-open
 * hub 必须能发现它(只读探测:ps + lsof),且不能把自己的 spawn 或 shell 包装误报成外部实例。
 */

/** 真实机器上抓到的行(评测脚本自身也会出现在 ps 输出里 —— 必须排除) */
const REAL_PS = [
  '  1 /sbin/launchd',
  '  84758 node /Users/dev/.local/bin/dsh web --patch /Users/dev/.dush/cordis.dush.patch.yml --no-open',
  '  34325 bash -c cd /Users/dev/workspace/private/dsh-plugins/dsh-hub-desktop && ps -axo pid=,command= | grep "dsh web"',
  '  34327 grep dsh web',
  '  9001 node /Applications/DSH Hub.app/Contents/Resources/app.asar/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js --profile default --host 127.0.0.1 --port 30501 --no-open'
].join('\n')

describe('isDshWebCommand(命令行判定)', () => {
  it('识别真实 dush 形态:dsh web --patch …', () => {
    expect(
      isDshWebCommand(
        'node /Users/dev/.local/bin/dsh web --patch /Users/dev/.dush/cordis.dush.patch.yml --no-open'
      )
    ).toBe(true)
  })

  it('识别 hub 运行时入口形态:@deepseek-ai/dsh/lib/bin.js web', () => {
    expect(
      isDshWebCommand(
        'node /opt/hub/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 52300'
      )
    ).toBe(true)
  })

  it('排除 shell/grep 包装(它们把 dsh web 当参数)', () => {
    expect(isDshWebCommand('grep dsh web')).toBe(false)
    expect(isDshWebCommand('bash -c ps -axo pid=,command= | grep "dsh web"')).toBe(false)
    expect(isDshWebCommand('/bin/zsh -lc command -v dsh; dsh --version')).toBe(false)
  })

  it('排除 hub 自己 spawn 的进程(无 web 子命令)', () => {
    expect(
      isDshWebCommand(
        'node /…/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js --profile default --host 127.0.0.1 --port 30501 --no-open'
      )
    ).toBe(false)
  })

  it('排除无关进程与「目录名里带 dsh」的干扰项', () => {
    expect(isDshWebCommand('/usr/sbin/cupsd')).toBe(false)
    expect(isDshWebCommand('node /Users/dev/dsh-plugins/dsh-hub-desktop/out/main/index.js')).toBe(
      false
    )
    expect(isDshWebCommand('node /Users/dev/.local/bin/dsh --version')).toBe(false)
  })
})

describe('patchOf / portOf(参数解析)', () => {
  it('空格与等号两种写法都能取到 --patch', () => {
    expect(patchOf('dsh web --patch /a/b.yml')).toBe('/a/b.yml')
    expect(patchOf('dsh web --patch=/a/b.yml')).toBe('/a/b.yml')
    expect(patchOf('dsh web --no-open')).toBeNull()
  })

  it('--port 取合法端口,非法值返回 null(留给 lsof 兜底)', () => {
    expect(portOf('dsh web --port 52300')).toBe(52300)
    expect(portOf('dsh web --port=3080')).toBe(3080)
    expect(portOf('dsh web --port 99999')).toBeNull()
    expect(portOf('dsh web --no-open')).toBeNull()
  })
})

describe('parseDshWebProcesses(ps 解析)', () => {
  it('从真实 ps 输出中只挑出 dsh web 进程,并解析 patch', () => {
    const found = parseDshWebProcesses(REAL_PS)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      pid: 84758,
      patch: '/Users/dev/.dush/cordis.dush.patch.yml',
      port: null // 命令行没写 --port → 交 lsof 兜底
    })
    expect(found[0]?.command).toContain('/.local/bin/dsh web')
  })

  it('同一 pid 只上报一次;空输出返回空数组', () => {
    const dup = parseDshWebProcesses(
      ['1 node /x/dsh web', '1 node /x/dsh web --patch /p.yml', ''].join('\n')
    )
    expect(dup).toHaveLength(1)
    expect(parseDshWebProcesses('')).toEqual([])
  })

  it('超长命令行被截断(供 UI 展示,不撑破布局)', () => {
    const long = `node /x/dsh web --patch /${'a'.repeat(400)}.yml`
    const found = parseDshWebProcesses(`1 ${long}`)
    expect(found[0]?.command.length).toBeLessThanOrEqual(241)
    expect(found[0]?.command.endsWith('…')).toBe(true)
  })
})

describe('parseListeningPorts(lsof 解析)', () => {
  it('pid → 首个监听端口', () => {
    const output = [
      'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'node-darw  4323 dev   38u  IPv4 0x1      0t0  TCP 127.0.0.1:49152 (LISTEN)',
      'node      84758 dev   21u  IPv4 0x2      0t0  TCP *:3080 (LISTEN)',
      'node      84758 dev   22u  IPv6 0x3      0t0  TCP *:3081 (LISTEN)',
      'node      84758 dev   23u  IPv4 0x4      0t0  TCP 127.0.0.1:3080 (ESTABLISHED)'
    ].join('\n')
    const ports = parseListeningPorts(output)
    expect(ports.get(84758)).toBe(3080) // 首个 LISTEN;ESTABLISHED 不算
    expect(ports.get(4323)).toBe(49152)
  })
})

describe('createExternalDshScanner(注入 IO)', () => {
  it('ps 找到进程且命令行无 --port → 用 lsof 补端口', async () => {
    const scanner = createExternalDshScanner({
      run: async (command) => {
        if (command === 'ps') {
          return {
            code: 0,
            stdout:
              '  84758 node /Users/dev/.local/bin/dsh web --patch /Users/dev/.dush/cordis.dush.patch.yml --no-open\n'
          }
        }
        return { code: 0, stdout: 'node 84758 dev 21u IPv4 0x2 0t0 TCP *:3080 (LISTEN)\n' }
      }
    })
    await expect(scanner.scan()).resolves.toEqual([
      {
        pid: 84758,
        port: 3080,
        patch: '/Users/dev/.dush/cordis.dush.patch.yml',
        command:
          'node /Users/dev/.local/bin/dsh web --patch /Users/dev/.dush/cordis.dush.patch.yml --no-open'
      }
    ])
  })

  it('命令行已带 --port 时不再查 lsof(省一次外部进程)', async () => {
    const calls: string[] = []
    const scanner = createExternalDshScanner({
      run: async (command) => {
        calls.push(command)
        if (command === 'ps') return { code: 0, stdout: '1 node /x/dsh web --port 52300\n' }
        return { code: 0, stdout: '' }
      }
    })
    const found = await scanner.scan()
    expect(found[0]?.port).toBe(52300)
    expect(calls).toEqual(['ps'])
  })

  it('ps 失败 / lsof 失败都退化为空数组或 null 端口,不抛异常', async () => {
    const failing = createExternalDshScanner({
      run: async () => {
        throw new Error('ps not available')
      }
    })
    await expect(failing.scan()).resolves.toEqual([])

    const lsofFails = createExternalDshScanner({
      run: async (command) => {
        if (command === 'ps') return { code: 0, stdout: '1 node /x/dsh web\n' }
        throw new Error('lsof failed')
      }
    })
    await expect(lsofFails.scan()).resolves.toEqual([
      { pid: 1, port: null, patch: null, command: 'node /x/dsh web' }
    ])
  })

  it('没有 dsh web 进程时返回空数组', async () => {
    const scanner = createExternalDshScanner({
      run: async () => ({ code: 0, stdout: '1 /sbin/launchd\n2 node /x/other.js\n' })
    })
    await expect(scanner.scan()).resolves.toEqual([])
  })

  it('win32 暂不探测(避免误报),返回空数组', async () => {
    const scanner = createExternalDshScanner({ platform: 'win32', run: async () => ({ code: 0, stdout: '1 node /x/dsh web\n' }) })
    await expect(scanner.scan()).resolves.toEqual([])
  })
})
