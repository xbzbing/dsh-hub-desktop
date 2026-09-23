/**
 * 本机实例可选启动器的安全解析。
 * 启动器只能是 PATH 中的 dsh、dush 或 duush；所有参数由 Hub 自行构造，绝不经 shell 执行。
 */

/** 支持的启动器可执行名；dsh 为默认，其余由用户自行安装。 */
export const LAUNCHERS = ['dsh', 'dush', 'duush'] as const

export type LocalLauncher = (typeof LAUNCHERS)[number]

/** 拒绝路径、空白、子命令与 shell 片段，只保留固定可执行名。 */
export function parseLocalLauncher(input: string): LocalLauncher | null {
  const launcher = input.trim()
  return (LAUNCHERS as readonly string[]).includes(launcher) ? (launcher as LocalLauncher) : null
}
