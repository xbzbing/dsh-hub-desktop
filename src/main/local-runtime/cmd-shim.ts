/**
 * win32 `.cmd` shim 解析。Node 自 CVE-2024-27980 起拒绝在无 shell 时 spawn
 * `.cmd`/`.bat`，而 npm 全局入口（dsh/dush/duush）在 Windows 恰好是 `.cmd`：
 * shim 的实体是它引用的入口 `.js`，解析出来后由 node 直跑（与 npm 的
 * `node.exe + npm-cli.js` 同一思路）。解析不了的 shim 一律返回 null，由调用方
 * 快速失败，不再构造注定 EINVAL/ENOENT 的调用。
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export interface CmdShimDeps {
  /** 读 shim 文本（测试注入）；缺省读磁盘 */
  read?: (path: string) => string
  /** 入口脚本存在性检查（测试注入）；缺省 fs.existsSync */
  exists?: (path: string) => boolean
}

/** `"%dp0%\<入口>.js"` / 旧式 `"%~dp0\..."`：dp0 即 .cmd 所在目录 */
const DP0_SCRIPT = /"%(?:dp0%|~dp0)\\([^"]+?\.[cm]?js)"/i
/** 退一步：带 node_modules 的入口引用（绝对路径或其他变体） */
const NODE_MODULES_SCRIPT = /"([^"]*node_modules[^"]+?\.[cm]?js)"/i

/** `.cmd` 所在目录：同时容忍两种分隔符，判定不依赖宿主平台（win32 路径在 POSIX 测试中同样可解析）。 */
function shimDirOf(cmdPath: string): string {
  const normalized = cmdPath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index < 0) return '.'
  const base = normalized.slice(0, index)
  return /^[A-Za-z]:$/.test(base) ? `${base}/` : base
}

/** 解析 `.cmd` shim 指向的入口脚本绝对路径；内容不可解析 / 文件不存在返回 null。 */
export function resolveCmdShim(cmdPath: string, deps: CmdShimDeps = {}): string | null {
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'))
  const exists = deps.exists ?? existsSync
  let content: string
  try {
    content = read(cmdPath)
  } catch {
    return null
  }
  const match = DP0_SCRIPT.exec(content) ?? NODE_MODULES_SCRIPT.exec(content)
  const captured = match?.[1]
  if (captured === undefined) return null
  const relative = captured.replace(/\\/g, '/')
  const script = isAbsolute(relative) ? relative : join(shimDirOf(cmdPath), relative)
  return exists(script) ? script : null
}
