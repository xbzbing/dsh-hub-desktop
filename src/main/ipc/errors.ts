/**
 * IPC 层跨 handler 重复的用户可见错误文案，集中一处。
 * 文案变更需同步 `i18n-coverage.test.ts` 的债务清单（按文件 + 行文本登记）。
 */

/** 本机进程探测器未装配（单测等场景缺省不注入）。 */
export const SCANNER_UNAVAILABLE = '本机进程探测能力不可用'

/** 目标进程已找到，但监听端口尚未确定，无法接管。 */
export const LISTEN_PORT_UNDETERMINED = '该进程的监听端口未能确定，无法接管'

/** 保存的外部访问 token 已不再被目标端点接受。 */
export const EXTERNAL_ACCESS_TOKEN_INVALID = '访问 token 无效，请重新输入'

/** 按 pid 扫描本机 dsh web 进程未命中。 */
export const notFoundDshPid = (pid: number): string => `未找到 pid ${pid} 的 dsh web 进程`
