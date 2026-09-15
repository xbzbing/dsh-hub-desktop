/**
 * 「打开数据目录」的主进程实现（T11 三审 Finding 1）—— 不 import electron,便于单测。
 *
 * 设置页的「打开」按钮此前**根本不存在**(数据目录只有只读 `<p>`),而设计稿
 * (`design/dsh-hub-desktop.html` 的 `data-act="open-dir"`)与 PRD §292 都要求「展示 + 打开」。
 *
 * 安全要点(这是本模块存在的**首要**理由):
 * 通道**不接受任何路径参数**。目录由主进程从 `DSH_HUB_DATA_DIR` 覆盖 /
 * `app.getPath('userData')` 自行解析,渲染层只能触发「打开」这个动作本身 ——
 * 因此结构上不可能被用作「任意文件/目录打开」原语。绝不要给 `open()` 加参数,
 * 也绝不要校验渲染层给的路径:那意味着已经走错了方向。
 */

/** 打开数据目录失败:带稳定错误码,由 IPC 层映射成错误信封(PRD §8 码表) */
export class DataDirOpenError extends Error {
  constructor(
    readonly code: 'io-error' | 'internal',
    message: string
  ) {
    super(message)
    this.name = 'DataDirOpenError'
  }
}

/** 打开数据目录所需的副作用端口(生产由 electron 实现,测试用 spy) */
export interface OpenDataDirPorts {
  /** 应用数据根目录(装配层负责让 `DSH_HUB_DATA_DIR` 覆盖生效) */
  dataDir(): string
  /**
   * 交给系统文件管理器打开。
   * 沿用 electron `shell.openPath` 的约定:**返回空串表示成功**,非空串是失败原因。
   */
  openPath(path: string): Promise<string>
}

export interface DataDirOpener {
  /** 打开主进程自己解析出的数据目录;无参数(见文件头安全说明) */
  open(): Promise<void>
}

/**
 * 把「打开数据目录」落到端口上。
 *
 * 成功即正常返回;任何失败都**抛错**(由 IPC 层 `wrap` 转成
 * `{ok:false,code,message}` 信封)—— 绝不静默成功,也绝不产生未处理的 rejection。
 */
export function createDataDirOpener(ports: OpenDataDirPorts): DataDirOpener {
  return {
    async open(): Promise<void> {
      const dir = ports.dataDir().trim()
      if (dir === '') throw new DataDirOpenError('internal', '数据目录不可用')
      let failure: string
      try {
        failure = await ports.openPath(dir)
      } catch (error) {
        throw new DataDirOpenError(
          'io-error',
          error instanceof Error ? error.message : String(error)
        )
      }
      if (failure !== '') throw new DataDirOpenError('io-error', failure)
    }
  }
}
