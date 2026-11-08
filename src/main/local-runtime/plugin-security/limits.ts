/**
 * 安全检查的硬上限：防止恶意/异常包把主进程拖垮。
 *
 * 所有上限只约束「检查」本身，不改变安装行为；超限按 `unavailable`/`partial` 降级，
 * 由用户显式选择是否仍要安装。
 */
export const SECURITY_LIMITS = {
  /** tarball 压缩体积上限。 */
  maxTarballBytes: 30 * 1024 * 1024,
  /** 解压后总体积上限。 */
  maxUnpackedBytes: 100 * 1024 * 1024,
  /** tar 条目数上限。 */
  maxEntries: 5000,
  /** 单个文件参与静态扫描的最大字节数。 */
  maxFileScanBytes: 8 * 1024 * 1024,
  /** 一次检查参与扫描的文本总量上限。 */
  maxTotalScanBytes: 64 * 1024 * 1024,
  /** 内容扫描时间预算（毫秒）。 */
  maxScanMs: 2500,
  /** registry 元数据响应上限。 */
  maxManifestBytes: 1024 * 1024,
  maxPackumentBytes: 8 * 1024 * 1024,
  /** 下载量接口响应上限。 */
  maxDownloadsBytes: 256 * 1024,
  /** OSV 响应上限。 */
  maxOsvBytes: 2 * 1024 * 1024,
  /** 单个网络请求超时（毫秒）。 */
  requestTimeoutMs: 8_000,
  /** 整个检查的总预算（毫秒）。 */
  totalTimeoutMs: 20_000
} as const
