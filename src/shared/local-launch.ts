/**
 * 本机实例可选启动器的安全解析。
 * 启动器只能是 PATH 中的 dsh 或 dush；所有参数由 Hub 自行构造，绝不经 shell 执行。
 */
export type LocalLauncher = 'dsh' | 'dush'

/** 拒绝路径、空白、子命令与 shell 片段，只保留两个固定可执行名。 */
export function parseLocalLauncher(input: string): LocalLauncher | null {
  const launcher = input.trim()
  return launcher === 'dsh' || launcher === 'dush' ? launcher : null
}
