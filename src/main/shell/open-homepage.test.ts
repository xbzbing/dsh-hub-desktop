import { describe, expect, it, vi } from 'vitest'
import { HOMEPAGE_URL } from '@shared/contracts'
import { createHomepageOpener, HomepageOpenError } from './open-homepage'

describe('createHomepageOpener（打开项目主页）', () => {
  it('只以主进程固定的项目主页调用系统浏览器', async () => {
    const openExternal = vi.fn(async () => undefined)
    await createHomepageOpener({ openExternal }).open()

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith(HOMEPAGE_URL)
  })

  it('打开失败抛 HomepageOpenError（由 IPC 层转成错误信封，不静默成功）', async () => {
    const openExternal = vi.fn(async () => {
      throw new Error('no browser')
    })

    await expect(createHomepageOpener({ openExternal }).open()).rejects.toThrow(HomepageOpenError)
  })
})
