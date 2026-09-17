import { describe, expect, it } from 'vitest'
import { parseLocalLauncher } from './local-launch'

describe('parseLocalLauncher', () => {
  it('仅接受 dsh 或 dush 启动器', () => {
    expect(parseLocalLauncher('dsh')).toBe('dsh')
    expect(parseLocalLauncher('dush')).toBe('dush')
  })

  it('拒绝包含子命令、参数、路径或 shell 片段的输入', () => {
    expect(parseLocalLauncher('dush web --patch ./dev.yml')).toBeNull()
    expect(parseLocalLauncher('node server.js')).toBeNull()
    expect(parseLocalLauncher('dsh --port 8080')).toBeNull()
    expect(parseLocalLauncher('dsh; rm -rf /')).toBeNull()
  })
})
