/**
 * SSH spawn 参数库（T4,设计文档 §4.2 表）—— 纯函数，不 import electron。
 *
 * 全部显式传参，不依赖用户全局配置漂移；argv 以数组传入、不经 shell（无命令注入面）。
 * 契约层约束：host 仅字母数字/._-:[] 且**不以 `-` 开头**（否则会被 ssh 当选项解析）；
 * username / identityFile 作为 `-l` / `-i` 的参数被消费，不构成位置参数。
 *
 * 别名模式说明：`host` 也可能是 `~/.ssh/config` 别名。T4 没有 `ssh -G` 解析
 * （T5 引入），因此 `-p`/`-l`/`-i` 只在用户显式指定时才传：
 * 默认（22 / 未填）视为「交给 config 决定」，别名路径即可自然生效。
 */
import type { SshInstance } from '@shared/contracts'

export interface SshArgsOptions {
  /** 本实例 ControlPath（隧道复用/清理用），建议 `<dataRoot>/ssh/inst-<id>.sock` */
  controlPath: string
  /** 私有 known_hosts 路径；配合 accept-new 写入 hub 私有文件，不污染用户 ~/.ssh */
  knownHostsPath: string
}

export function buildSshArgs(
  instance: SshInstance,
  localPort: number,
  options: SshArgsOptions
): string[] {
  const args = [
    // 只做转发，不开远程 shell
    '-N',
    // sshd 仅当用户显式选了非默认端口才传；默认交给 ~/.ssh/config（别名模式）
    ...(instance.port !== 22 ? ['-p', String(instance.port)] : []),
    // 用户名必填（契约）；显式 -l 与别名 config 的 User 冲突时以实例为准
    '-l',
    instance.username,
    ...(instance.identityFile ? ['-i', instance.identityFile] : []),
    // 本地监听 <localPort> → 隧道远端 127.0.0.1:<remotePort>
    '-L',
    `${localPort}:127.0.0.1:${instance.remotePort}`
  ]

  // 连接与保活参数（§4.2 表：全部显式，不依赖用户全局配置漂移）
  const optionsList = [
    'ExitOnForwardFailure=yes', // 端口绑定失败立即退出（而不是挂起），便于看门狗归因
    'ServerAliveInterval=15', // 15s 心跳
    'ServerAliveCountMax=3', // 3 次失联判死 —— 比 TCP 超时快得多
    `ConnectTimeout=10`,
    'ControlMaster=auto', // 同一实例的并发连接复用一条 SSH 连接
    // ⚠️ 必须显式 ControlPersist=no：本机 ~/.ssh/config 常见 `ControlPersist yes`，
    // 若不钉住，ssh 会 fork 出后台 master 而前台进程退出 0 —— hub 跟踪的是已退出的
    // 前台，真正持隧道的是「未跟踪的 master」，停止/退出时回收不掉（实测孤儿）
    'ControlPersist=no',
    `ControlPath=${options.controlPath}`,
    // T5 起改为严格模式:TOFU 已在连接前完成(ssh-keyscan 预取指纹 → UI 确认 →
    // 写入 hub 私有 known_hosts),此处不再允许 ssh 自行接受未知主机
    'StrictHostKeyChecking=yes',
    `UserKnownHostsFile=${options.knownHostsPath}`
  ]
  for (const option of optionsList) args.push('-o', option)

  args.push(instance.host)
  return args
}