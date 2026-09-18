/**
 * Instance registry types and validation rules.
 *
 * 本模块不 import electron；主进程、preload、渲染进程和测试共享模型与 Zod schema。
 * `transport` 是判别联合的判别字段。
 */
import { z } from 'zod'
import { tryParseEndpoint } from './endpoint'

// ===== 枚举 =====

export const TRANSPORTS = ['local', 'ssh', 'http'] as const
export type Transport = (typeof TRANSPORTS)[number]

/**
 * 用户显式选择的认证意图；`auto` 为默认 —— 连接建立后由认证层探测决定有效模式
 * （none / gateway / browser-auth）。browser-auth 只可能是探测产物，
 * 不存在于注册表记录中。
 */
export const AUTH_MODES = ['auto', 'none', 'gateway'] as const
export type AuthMode = (typeof AUTH_MODES)[number]

// ===== 基础字段 =====

const PORT_SCHEMA = z.number('端口必须是数字').int('端口必须是整数').min(1, '端口最小 1').max(65535, '端口最大 65535')

/**
 * SSH 主机合法性：
 * - 普通主机名 / 别名 / IPv4：不含冒号即可；
 * - 裸 IPv6：至少两个冒号且全为十六进制字符；
 * - `host[:port]` / `[v6][:port]`：端口必须落在 1–65535（非法端口组合显式拒绝，
 *   而不是把整串存进 host 字段）。
 */
const SSH_PORT_PATTERN = /^(\d+)$/

function parseSshPort(rawPort: string): number | null {
  if (!SSH_PORT_PATTERN.test(rawPort)) return null
  return inPortRange(rawPort) ? Number(rawPort) : null
}

function isValidSshHost(host: string): boolean {
  const portOfPlain = /^([A-Za-z0-9._-]+):(\d+)$/.exec(host)
  if (portOfPlain) return parseSshPort(portOfPlain[2] ?? '') !== null
  const portOfBracket = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(host)
  if (portOfBracket) return portOfBracket[2] === undefined || parseSshPort(portOfBracket[2]) !== null
  if (host.includes(':')) {
    // 裸 IPv6（含 IPv4-mapped 点分尾巴 `::ffff:192.168.1.5`）：至少两个冒号且字符集合法
    return /^[0-9a-fA-F:.]+$/.test(host) && (host.match(/:/g)?.length ?? 0) >= 2
  }
  return true
}

function inPortRange(rawPort: string | undefined): boolean {
  const port = Number(rawPort)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * SSH 主机：主机名、别名、IPv4、裸或方括号 IPv6，以及带端口的组合形式。
 * 组合形式由 instance-store 拆分为独立的 host 和 port 字段。
 * 不允许空白、`/`、`@`（userinfo 属于 username 字段，不内嵌主机）。
 */
const SSH_HOST_SCHEMA = z
  .string()
  .trim()
  .min(1, 'SSH 主机不能为空')
  .max(255, 'SSH 主机最长 255 字符')
  .regex(/^[A-Za-z0-9._\-:[\]]+$/, 'SSH 主机含非法字符（不允许空白 / 斜杠 / @）')
  // host 是 ssh 的位置参数:以 '-' 开头会被当作选项解析(argv 选项注入面),
  // 在边界直接拒绝；`-oProxyCommand=` 之类因字符集不含 '=' 本就被拒。
  .refine((value) => !value.startsWith('-'), 'SSH 主机不能以 - 开头')
  .refine(isValidSshHost, 'host[:port] 形态的端口必须在 1–65535，或主机名不含冒号')

const SAFE_PROFILE_SCHEMA = z
  .string()
  .trim()
  .min(1, '配置档案不能为空')
  .max(128, '配置档案最长 128 字符')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, '配置档案只能是相对路径，且不能以 - 开头')
  .refine((value) => !value.split('/').includes('..'), '配置档案不能包含 ..')

const instanceBaseFields = {
  id: z.uuid(),
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 字符'),
  authMode: z.enum(AUTH_MODES),
  /** 备注可为空：null / 省略均表示无备注（补丁层用 null 显式清空） */
  notes: z.string().trim().max(2000, '备注最长 2000 字符').nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}

// ===== 三种变体（判别联合） =====

export const LocalInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('local'),
  /** 已安装的 dsh 版本；null = 未安装。 */
  dshVersion: z.string().trim().max(64).nullable().default(null),
  /** 已分配的监听端口；null = 未分配。 */
  port: PORT_SCHEMA.nullable().default(null),
  /** 实例配置文件（相对 DSH_HOME） */
  profile: SAFE_PROFILE_SCHEMA.nullable().default(null),
  /** 可选的 dsh/dush 启动器；null = 默认 dsh。参数由 Hub 固定构造。 */
  launcher: z.enum(['dsh', 'dush']).nullable().default(null),
  /** true 时复用用户的 ~/.dsh，而非 Hub 的隔离实例目录。 */
  useDefaultSpace: z.boolean().default(false),
  /** 应用启动时自动拉起 */
  autoStart: z.boolean().default(false)
})

export const SshInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('ssh'),
  host: SSH_HOST_SCHEMA,
  /** SSH 连接端口 */
  port: PORT_SCHEMA.default(22),
  username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128, 'SSH 用户名最长 128 字符'),
  /** 远端 dsh 监听端口（隧道目标，默认 dsh web 惯例端口） */
  remotePort: PORT_SCHEMA.default(3080),
  /** 隧道本地端口；null = 未分配。 */
  localPort: PORT_SCHEMA.nullable().default(null),
  /** 显式私钥路径；null = 默认，优先使用 agent。 */
  identityFile: z.string().trim().max(512).nullable().default(null)
})

export const HttpInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('http'),
  /** HTTP 直连端点。存归一化 baseUrl；userinfo、查询串和锚点由 parseEndpointUrl 拒绝。 */
  endpointUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => tryParseEndpoint(value).ok, '端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）')
})

export const InstanceRecordSchema = z.discriminatedUnion('transport', [
  LocalInstanceSchema,
  SshInstanceSchema,
  HttpInstanceSchema
])
export type InstanceRecord = z.infer<typeof InstanceRecordSchema>
export type LocalInstance = Extract<InstanceRecord, { transport: 'local' }>
export type SshInstance = Extract<InstanceRecord, { transport: 'ssh' }>
export type HttpInstance = Extract<InstanceRecord, { transport: 'http' }>

// ===== 创建输入（IPC 边界，.strict()：未知字段一律拒绝） =====

const createBaseFields = {
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 字符'),
  authMode: z.enum(AUTH_MODES).default('auto'),
  notes: z.string().trim().max(2000).nullable().optional()
}

export const CreateInstanceInputSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...createBaseFields,
      transport: z.literal('local'),
      dshVersion: z.string().trim().max(64).optional(),
      port: PORT_SCHEMA.optional(),
      profile: SAFE_PROFILE_SCHEMA.optional(),
      launcher: z.enum(['dsh', 'dush']).optional(),
      useDefaultSpace: z.boolean().optional(),
      /** 创建后接管检测到的外部 dsh web；这些瞬时输入不写入注册表。 */
      useExistingExternal: z.boolean().optional(),
      externalPid: z.number().int().positive().optional(),
      externalAccess: z.string().trim().min(1).max(4096).optional(),
      autoStart: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      ...createBaseFields,
      transport: z.literal('ssh'),
      host: SSH_HOST_SCHEMA,
      port: PORT_SCHEMA.optional(),
      username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128),
      remotePort: PORT_SCHEMA.optional(),
      localPort: PORT_SCHEMA.optional(),
      identityFile: z.string().trim().max(512).optional()
    })
    .strict(),
  z
    .object({
      ...createBaseFields,
      transport: z.literal('http'),
      endpointUrl: z
        .string()
        .trim()
        .max(2048)
        .refine((value) => tryParseEndpoint(value).ok, '端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）')
    })
    .strict()
])
/**
 * 调用方（渲染层 / preload / 测试）传入的创建参数：默认值字段可省略，
 * 因此用 z.input 而非 z.infer（后者是已填默认值的输出类型，会把 authMode 变成必填）。
 */
export type CreateInstanceInput = z.input<typeof CreateInstanceInputSchema>
/** 经 schema 解析后的规范形态（store 内部使用） */
export type CreateInstanceParams = z.output<typeof CreateInstanceInputSchema>

// ===== 更新补丁（transport 不可变：改传输形态 = 删除重建） =====

export const PatchInstanceSchema = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(64).optional(),
    authMode: z.enum(AUTH_MODES).optional(),
    /** null 用于清空备注 */
    notes: z.string().trim().max(2000).nullable().optional(),
    // —— local ——
    dshVersion: z.string().trim().max(64).nullable().optional(),
    port: PORT_SCHEMA.nullable().optional(),
    profile: SAFE_PROFILE_SCHEMA.nullable().optional(),
    launcher: z.enum(['dsh', 'dush']).nullable().optional(),
    useDefaultSpace: z.boolean().optional(),
    autoStart: z.boolean().optional(),
    // —— ssh ——
    host: SSH_HOST_SCHEMA.optional(),
    username: z.string().trim().min(1).max(128).optional(),
    remotePort: PORT_SCHEMA.optional(),
    localPort: PORT_SCHEMA.nullable().optional(),
    identityFile: z.string().trim().max(512).nullable().optional(),
    // —— http ——
    endpointUrl: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => tryParseEndpoint(value).ok, '端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）')
      .optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, '补丁不能为空')
export type PatchInstanceInput = z.input<typeof PatchInstanceSchema>
/** 经 schema 解析后的补丁（store 内部使用） */
export type PatchInstanceParams = z.output<typeof PatchInstanceSchema>

// ===== SSH 密钥预览 / 主机指纹确认 / askpass =====

/**
 * SSH 通道：
 * - `keyPreview`：向导/详情页只读展示「将使用哪个密钥」与 agent 状态（绝不含私钥内容）；
 * - `hostKeyDecision`(主→渲染) + `hostKeyReply`(渲染→主)：TOFU 指纹确认（首次/变化双变体）；
 * - `hostKeyForget`(渲染→主)：**显式、破坏性**的恢复动作「忘记该主机指纹」。连接时指纹变化
 *   一律拒绝且不自动清理，只有走完本动作后下一次连接才重新走首次 TOFU；
 * - `askpassRequest`(主→渲染) + `askpassReply`(渲染→主)：SSH 口令/密钥口令弹窗，
 *   口令只经 IPC 瞬时传递，不落盘、不入日志、不进审计。
 */
export const SSH_IPC = {
  keyPreview: 'ssh:keyPreview',
  hostKeyDecision: 'ssh:hostKeyDecision',
  hostKeyReply: 'ssh:hostKeyReply',
  hostKeyForget: 'ssh:hostKeyForget',
  askpassRequest: 'ssh:askpassRequest',
  askpassReply: 'ssh:askpassReply'
} as const

/** 密钥预览输入（向导里的草稿，未必已入库） */
export const SshKeyPreviewInputSchema = z
  .object({
    host: SSH_HOST_SCHEMA,
    port: PORT_SCHEMA.default(22),
    username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128),
    identityFile: z.string().trim().max(512).nullable().optional()
  })
  .strict()
export type SshKeyPreviewInput = z.input<typeof SshKeyPreviewInputSchema>

export type SshAgentStatus = 'ready' | 'empty' | 'unavailable'

export interface SshAgentKeyInfo {
  type: string
  typeLabel: string
  /** 公钥体（只读展示，不含任何私钥信息） */
  blob: string
  comment: string | null
  fingerprint: string
}

export interface SshKeyPreviewResult {
  target: string
  resolved: { user: string; host: string; port: number }
  identityFiles: string[]
  agent: { status: SshAgentStatus; keys: SshAgentKeyInfo[] }
  explicitIdentityFile: string | null
}

export interface HostKeyFingerprintInfo {
  type: string
  typeLabel: string
  fingerprint: string
}

/** 指纹确认请求（主 → 渲染）；verdict=changed 时 UI 走红色警示且默认拒绝 */
export interface HostKeyPromptPayload {
  requestId: string
  instanceId: string
  /** 目标标签（host 或 host:port） */
  target: string
  verdict: 'unknown' | 'changed'
  fingerprints: HostKeyFingerprintInfo[]
  previousFingerprints: HostKeyFingerprintInfo[]
}

export type HostKeyDecision = 'trust' | 'reject'

export interface HostKeyReplyPayload {
  requestId: string
  decision: HostKeyDecision
}

/**
 * 「忘记该主机指纹」输入（渲染 → 主）。
 *
 * 删除已保存的指纹后，下一次连接会重新按首次连接核对新指纹。
 * 该操作不属于连接确认流程，且只能由用户单独发起。
 */
export interface SshHostKeyForgetInput {
  instanceId: string
}

/** askpass 口令请求（主 → 渲染）；secret 只经 IPC 瞬时传递 */
export interface AskpassPromptPayload {
  requestId: string
  instanceId: string
  prompt: string
}

export interface AskpassReplyPayload {
  requestId: string
  /** null = 用户取消 */
  secret: string | null
}

// ===== HTTP 直连端点探测 =====

/**
 * 向导和详情页对「直连端点」做一次只读探测，
 * 返回认证模式判定结果供 UI 展示；不建立实例、不写注册表、不携带凭据。
 */
export const HTTP_IPC = {
  detect: 'http:detect'
} as const

export type DetectedAuthMode = 'gateway' | 'none' | 'browser-auth' | 'unreachable' | 'unknown'

export type GatewayEvidence = 'login-page' | 'api-401' | 'onboarding' | 'otp-page'

export interface HttpAuthDetection {
  mode: DetectedAuthMode
  gatewayEvidence: GatewayEvidence | null
  /** 面向用户/日志的一句话证据（不含凭据） */
  evidence: string
  /** 观测状态码（网络错误为 null） */
  status: number | null
  at: string
}

// ===== 认证：状态流与登录提交 =====

/**
 * 渲染层只触发登录与观察状态，凭据只在主进程内存中流转，不落盘或写入日志。
 * - `auth:probe` 探测并静默恢复(带已存 Cookie);
 * - `auth:login` 提交密码(可带 OTP 完成单请求 2FA —— 验证码阶段复用同一次密码重发,
 *   不做分步 /otp/verify；
 * - `auth:logout` 清除会话;
 * - `auth:state`(主→渲染)状态机快照,驱动 auth-panel 与工作区浮层。
 */
export const AUTH_IPC = {
  probe: 'auth:probe',
  login: 'auth:login',
  /** 使用保险库中的已存密码登录；密码不跨 IPC。 */
  loginStored: 'auth:loginStored',
  logout: 'auth:logout',
  state: 'auth:state',
  /** 会话失效/需要验证码等来自 webview 拦截的信号(主→渲染) */
  signal: 'auth:signal'
} as const

/**
 * 凭据保险库。
 * 通道命名与 auth:* 并列；策略默认保存，用户可显式取消。
 */
export const VAULT_IPC = {
  status: 'vault:status',
  setPolicy: 'vault:setPolicy',
  forget: 'vault:forget',
  clear: 'vault:clear'
} as const

/** 单个实例的记住策略。新实例默认保存密码和会话，用户可显式取消。 */
export const DEFAULT_VAULT_POLICY = {
  rememberPassword: true,
  rememberSession: true
} as const satisfies VaultPolicy

export const VaultPolicySchema = z.object({
  rememberPassword: z.boolean(),
  rememberSession: z.boolean()
})
export type VaultPolicy = z.infer<typeof VaultPolicySchema>

/** vault 状态(渲染层据此显示降级告警与「已记住」标记) */
export interface VaultStatusSnapshot {
  /** 系统钥匙串可用(safeStorage) */
  available: boolean
  /** 降级为纯内存模式:此时勾选也无意义,UI 必须告警 */
  degraded: boolean
  /** 已记住凭据的实例 id */
  rememberedInstances: string[]
  /** 当前实例的勾选策略，用于避免以过时状态覆盖另一个开关。 */
  policies: Record<string, VaultPolicy>
}

/**
 * 应用设置通道；敏感项一律走 vault。
 */
export const SETTINGS_IPC = {
  get: 'settings:get',
  update: 'settings:update',
  /** 应用数据目录由主进程自行解析；通道不接受参数。 */
  openDataDir: 'settings:openDataDir'
} as const

export type AuthPhase =
  | 'unknown'
  | 'probe'
  | 'needs-auth'
  | 'await-credentials'
  | 'await-otp'
  | 'connected'
  | 'error'

export interface AuthStateSnapshot {
  phase: AuthPhase
  needsOnboarding: boolean
  otpEnabled: boolean
  lockedForMs: number
  message: string | null
  lastErrorCode: string | null
}

/** `auth:state` 事件载荷 */
export interface AuthStateEvent {
  instanceId: string
  state: AuthStateSnapshot
  at: string
}

/** `auth:signal` 事件载荷(webview 拦截结论) */
export interface AuthSignalEvent {
  instanceId: string
  signal: 'session-expired' | 'needs-otp' | 'needs-onboarding'
  at: string
}

// ===== 注册表文件与版本迁移 =====

export const REGISTRY_SCHEMA_VERSION = 1

export const RegistryFileSchema = z.object({
  schemaVersion: z.number('schemaVersion 必须是数字').int().min(1),
  instances: z.array(InstanceRecordSchema)
})
export type RegistryFile = z.infer<typeof RegistryFileSchema>

export type RegistryMigration = (file: unknown) => unknown

// ===== 列表视图 / IPC =====

export interface InstanceSummary {
  id: string
  name: string
  transport: Transport
  authMode: AuthMode
  /** 展示用地址一次算好(避免渲染层为每行再发 get) */
  address: string
  /** 列表快照携带主进程已知的当前运行态，避免 renderer 重载后退回灰色 idle。 */
  runtimeStatus?: InstanceRuntimeStatus
  updatedAt: string
}

/** 实例注册表 CRUD 通道。 */
export const INSTANCE_IPC = {
  list: 'instances:list',
  get: 'instances:get',
  create: 'instances:create',
  update: 'instances:update',
  delete: 'instances:delete'
} as const

/** 本地运行时控制通道：start/stop 立即返回，进展由 `instance:status` 事件回推。 */
export const INSTANCE_RUNTIME_IPC = {
  start: 'instances:start',
  stop: 'instances:stop',
  openView: 'instances:openView',
  updateViewBounds: 'instances:updateViewBounds',
  hideView: 'instances:hideView',
  /** 只读探测本机 dsh/dush 启动器及版本，用于创建本机实例时的选择器。 */
  probeLocalDsh: 'instances:probeLocalDsh',
  /** 探测本机已运行的 dsh web 进程；返回 pid、端口和 patch 路径。 */
  scanExternal: 'instances:scanExternal',
  /** 接管外部 dsh 时提交 token 或完整 URL；主进程重新扫描 PID 并验证回环端口。 */
  adoptExternal: 'instances:adoptExternal',
} as const

export const WorkspaceViewBoundsSchema = z
  .object({
    x: z.number().int().min(0).max(10_000),
    y: z.number().int().min(0).max(10_000),
    width: z.number().int().min(0).max(20_000),
    height: z.number().int().min(0).max(20_000)
  })
  .strict()

export type WorkspaceViewBounds = z.infer<typeof WorkspaceViewBoundsSchema>

export interface LocalLauncherSnapshot {
  launcher: 'dsh' | 'dush'
  version: string
}

/** 本机已在运行的 dsh web(只读探测结果,供 UI 展示与「接管」) */
export interface ExternalDshWebSnapshot {
  pid: number
  /** 监听端口;null = 未能确定(无 --port 且 lsof 未给出) */
  port: number | null
  /** `--patch <file>` 取值(dush 形态);null = 未使用 patch */
  patch: string | null
  /** 原始命令行(已截断,仅供展示) */
  command: string
}

/** 主进程 → 渲染进程的状态推送通道（状态机推进的唯一来源） */
export const INSTANCE_STATUS_EVENT = 'instance:status'

export type InstanceRuntimeStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface InstanceStatusEvent {
  id: string
  status: InstanceRuntimeStatus
  /** 工作区 URL；本地 BrowserAuth bearer URL 仅留在主进程，不会出现在此状态事件。 */
  url?: string
  /** 实际监听端口（以 dsh 打印的就绪 URL 为准，可能与预分配端口不同） */
  port?: number
  /** 本次启动使用的 dsh 运行时版本（解析后回填，供 UI 展示与注册表回写） */
  version?: string
  /** 运行时来源：hub 为应用隔离目录，path 为用户 PATH，external 为接管的本机进程。 */
  runtimeSource?: 'hub' | 'path' | 'external'
  /** 人读诊断信息（进度 / 失败归因） */
  detail?: string
  /** 事件时间（ISO） */
  at: string
}

export type IpcErrorCode = 'invalid-input' | 'not-found' | 'invalid-state' | 'io-error' | 'internal'

/** IPC 统一响应信封：错误码稳定，文案由渲染层按码表映射。 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; code: IpcErrorCode; message: string }

// ===== 工具 =====

/** 把 zod 校验问题折叠成一条封顶的纯文本（供 IPC 错误信封使用） */
export function formatZodIssues(error: z.ZodError, cap = 300): string {
  const parts = error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
  )
  const joined = parts.join('; ')
  return joined.length > cap ? `${joined.slice(0, cap)}…` : joined
}

export interface SshHostPortSplit {
  host: string
  port: number
  /** 端口是否来自 host 内的 `:port` 组合形式；false 表示取 fallbackPort（调用方不应据此覆盖已有端口） */
  portEmbedded: boolean
}

/**
 * SSH `host[:port]` / `[v6][:port]` 组合形式拆分。
 * - 纯主机名 / 别名 / 裸 IPv6（含冒号但非 host:port 形态）原样返回，端口取 fallbackPort；
 * - 方括号形态一律剥离方括号（`[::1]` → `::1`、`[::1]:2222` → `::1` + 2222）；
 * - 字符类含 `.`，与 SSH_HOST_SCHEMA 的方括号分支保持一致（`[::ffff:192.168.1.1]`、
 *   `[192.0.2.1]:2222` 等点分形态也必须能拆分，否则端口会静默回退）。
 */
export function splitSshHostPort(host: string, fallbackPort: number): SshHostPortSplit {
  const plain = /^([A-Za-z0-9._-]+):(\d+)$/.exec(host)
  if (plain) {
    const port = parseSshPort(plain[2] ?? '')
    if (port !== null) return { host: plain[1] ?? '', port, portEmbedded: true }
  }
  const bracketedWithPort = /^\[([0-9a-fA-F:.]+)\]:(\d+)$/.exec(host)
  if (bracketedWithPort) {
    const port = parseSshPort(bracketedWithPort[2] ?? '')
    if (port !== null) return { host: bracketedWithPort[1] ?? '', port, portEmbedded: true }
  }
  // 方括号无端口形态 `[::1]`：只归一化主机形态，端口由调用方决定
  const bracketedPlain = /^\[([0-9a-fA-F:.]+)\]$/.exec(host)
  if (bracketedPlain) {
    return { host: bracketedPlain[1] ?? '', port: fallbackPort, portEmbedded: false }
  }
  return { host, port: fallbackPort, portEmbedded: false }
}