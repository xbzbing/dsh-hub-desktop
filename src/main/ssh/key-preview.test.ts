import { describe, expect, it } from 'vitest'
import { userInfo } from 'node:os'
import { parseAgentKeys, parseSshG } from './key-preview'

const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIL/GqayzeH4ALFQzq7BrQ4lodGaiDICVgULWk7rQZ4iw'
/** 模拟真实 `ssh -G` / `ssh-add -L` 输出:用户名取自当前环境,不写死某个账号 */
const USER = userInfo().username

describe('key-preview 解析（只读元信息，不碰私钥）', () => {
  it('parseSshG:提取全部 identityfile（优先级顺序）与生效 user/hostname/port', () => {
    const stdout = [
      'host dsh.internal',
      `user ${USER}`,
      'hostname dsh-really.internal',
      'port 2222',
      'identityfile ~/.ssh/id_rsa',
      'identityfile ~/.ssh/id_ed25519',
      'identitiesonly no'
    ].join('\n')
    const parsed = parseSshG(stdout)
    expect(parsed.user).toBe(USER)
    expect(parsed.host).toBe('dsh-really.internal') // 别名解析后的真实主机
    expect(parsed.port).toBe(2222)
    expect(parsed.identityFiles).toEqual(['~/.ssh/id_rsa', '~/.ssh/id_ed25519'])
  })

  it('parseSshG:空输出/噪音行不炸', () => {
    expect(parseSshG('')).toEqual({ user: null, host: null, port: null, identityFiles: [] })
    expect(parseSshG('canonicalizehostname false\nbisect\n').identityFiles).toEqual([])
  })

  it('parseAgentKeys:exit 0 且有公钥 = ready（含类型/注释/指纹）', () => {
    const stdout = `ssh-ed25519 ${ED} ${USER}@example\n`
    const result = parseAgentKeys(stdout, '', 0)
    expect(result.status).toBe('ready')
    expect(result.keys[0]?.typeLabel).toBe('ED25519')
    expect(result.keys[0]?.comment).toBe(`${USER}@example`)
    expect(result.keys[0]?.fingerprint).toMatch(/^SHA256:/)
  })

  it('parseAgentKeys:exit 0 但无身份 = empty', () => {
    expect(parseAgentKeys('The agent has no identities.\n', '', 0).status).toBe('empty')
  })

  it('parseAgentKeys:连接不上 agent（exit 2）= unavailable', () => {
    const result = parseAgentKeys('', 'Error connecting to agent: Connection refused\n', 2)
    expect(result.status).toBe('unavailable')
    expect(result.keys).toEqual([])
  })

  it('parseAgentKeys:忽略非公钥行', () => {
    const result = parseAgentKeys(`随便一行\nssh-ed25519 ${ED} c\n`, '', 0)
    expect(result.keys).toHaveLength(1)
  })
})
