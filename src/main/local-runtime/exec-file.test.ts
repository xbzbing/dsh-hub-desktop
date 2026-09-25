import { describe, expect, it } from 'vitest'
import { execFileResult } from './exec-file'

describe('execFileResult（子进程结果映射）', () => {
  it('正常退出返回退出码（零与非零都 resolve）', async () => {
    expect(await execFileResult(process.execPath, ['-e', 'process.exit(0)'])).toMatchObject({
      code: 0
    })
    expect(await execFileResult(process.execPath, ['-e', 'process.exit(7)'])).toMatchObject({
      code: 7
    })
  })

  it('启动失败（字符串错误码）reject', async () => {
    await expect(
      execFileResult('/definitely/not/a/real-binary-dsh-hub-test', [])
    ).rejects.toMatchObject({
      code: expect.stringMatching(/ENOENT|EACCES|EINVAL/)
    })
  })

  it('超时被杀 reject，绝不折算成 code 0 成功', async () => {
    const outcome = await execFileResult(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeout: 300
    }).then(
      (result) => ({ result, error: null }),
      (error: Error & { killed?: boolean }) => ({ result: null, error })
    )
    expect(outcome.result).toBeNull()
    expect(outcome.error).not.toBeNull()
    expect(outcome.error).toMatchObject({ killed: true })
  })
})
