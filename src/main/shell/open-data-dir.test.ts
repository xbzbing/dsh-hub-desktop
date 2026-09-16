import { describe, expect, it, vi } from 'vitest'
import { createDataDirOpener, DataDirOpenError } from './open-data-dir'

/**
 *
 * 重点不是「能打开」,而是**它永远打开主进程自己解析的那个目录**:
 * 渲染层给不出路径,所以这条通道不可能变成任意文件打开原语。
 */
function spyPorts(dir = '/Users/me/Library/Application Support/DSH Hub') {
  return {
    dataDir: vi.fn(() => dir),
    openPath: vi.fn(async () => '')
  }
}

describe('createDataDirOpener（打开数据目录:不接受路径参数）', () => {
  it('打开的是主进程解析出的数据目录(而不是任何入参)', async () => {
    const ports = spyPorts()
    await createDataDirOpener(ports).open()
    expect(ports.openPath).toHaveBeenCalledTimes(1)
    expect(ports.openPath).toHaveBeenCalledWith('/Users/me/Library/Application Support/DSH Hub')
  })

  it('open() 形参个数为 0:多传的字符串**不会**被当作路径(「接受路径参数」的锚点)', async () => {
    const ports = spyPorts('/data/hub')
    const opener = createDataDirOpener(ports)
    // 通道签名上没有参数 —— 结构上无法接收路径
    expect(opener.open.length).toBe(0)

    // 即便调用方硬塞一个路径,被打开的仍是主进程解析的目录
    await (opener.open as (extra?: string) => Promise<void>)('/etc/passwd')
    expect(ports.openPath).toHaveBeenCalledWith('/data/hub')
    expect(ports.openPath).not.toHaveBeenCalledWith('/etc/passwd')
  })

  it('openPath 返回非空错误串 → 抛 io-error(失败绝不静默成功)', async () => {
    const ports = spyPorts()
    ports.openPath.mockResolvedValue('Failed to open path')
    await expect(createDataDirOpener(ports).open()).rejects.toBeInstanceOf(DataDirOpenError)
    await expect(createDataDirOpener(ports).open()).rejects.toMatchObject({
      code: 'io-error',
      message: 'Failed to open path'
    })
  })

  it('openPath 自身抛错/reject → 收敛为 io-error(不产生未处理 rejection)', async () => {
    const ports = spyPorts()
    ports.openPath.mockRejectedValue(new Error('没有可用于打开目录的应用'))
    await expect(createDataDirOpener(ports).open()).rejects.toMatchObject({
      code: 'io-error',
      message: '没有可用于打开目录的应用'
    })
  })

  it('数据目录为空 → internal(不拿空串去调系统)', async () => {
    const ports = spyPorts('   ')
    await expect(createDataDirOpener(ports).open()).rejects.toMatchObject({ code: 'internal' })
    expect(ports.openPath).not.toHaveBeenCalled()
  })

  it('DSH_HUB_DATA_DIR 覆盖由装配层决定:目录值原样透传(含空格路径)', async () => {
    const ports = spyPorts('/tmp/dsh hub e2e')
    await createDataDirOpener(ports).open()
    expect(ports.openPath).toHaveBeenCalledWith('/tmp/dsh hub e2e')
  })
})
