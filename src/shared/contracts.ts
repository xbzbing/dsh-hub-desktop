/**
 * 实例注册表契约 —— 单一事实源（T2）。
 *
 * 设计依据：`docs/dsh-hub-desktop-design.md` §2.1（实例 = transport × auth 正交模型）、
 * `docs/desktop-implementation-plan.md` §4（IPC 契约）。
 *
 * 本模块不 import electron（全局规则 5）：主进程 / preload / 渲染进程 / 测试共享同一份
 * 模型与 zod schema；`transport` 为判别联合的判别字段（实现计划 §6.1 的 `kind` 即此字段）。
 */
import { z } from 'zod'
import { tryParseEndpoint } from './endpoint'

// ===== 枚举（§2.1） =====

export const TRANSPORTS = ['local', 'ssh', 'http'] as const
export type Transport = (typeof TRANSPORTS)[number]

/**
 * 用户显式选择的认证意图；`auto` 为默认 —— 连接建立后由认证层探测决定有效模式
 * （none / gateway / browser-auth，见设计文档 §2.3）。browser-auth 只可能是探测产物，
 * 不存在于注册表记录中。
 */
export const AUTH_MODES = ['auto', 'none', 'gateway'] as const
export type AuthMode = (typeof AUTH_MODES)[number]

// ===== 基础字段 =====

const PORT_SCHEMA = z.number('端口必须是数字').int('端口必须是整数').min(1, '端口最小 1').max(65535, '端口最大 65535')

/**
 * SSH 主机：主机名 / 别名 / IPv4 / [IPv6] / 以及 `host[:port]`、`[v6]:port` 组合形式
 * （组合形式由 instance-store 拆分为独立 host + port 字段）。
 * 不允许空白、`/`、`@`（userinfo 属于 username 字段，不内嵌主机）。
 */
const SSH_HOST_SCHEMA = z
  .string()
  .trim()
  .min(1, 'SSH 主机不能为空')
  .max(255, 'SSH 主机最长 255 字符')
  .regex(/^[A-Za-z0-9._\-:[\]]+$/, 'SSH 主机含非法字符（不允许空白 / 斜杠 / @）')

const instanceBaseFields = {
  id: z.uuid(),
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 字符'),
  authMode: z.enum(AUTH_MODES),
  notes: z.string().trim().max(2000, '备注最长 2000 字符').optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}

// ===== 三种变体（判别联合） =====

export const LocalInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('local'),
  /** 已安装的 dsh 版本；null = 未安装（T3 local-runtime 写入） */
  dshVersion: z.string().trim().max(64).nullable().default(null),
  /** 已分配的监听端口；null = 未分配（T3 端口分配后写入） */
  port: PORT_SCHEMA.nullable().default(null),
  /** 实例配置文件（相对 DSH_HOME） */
  profile: z.string().trim().max(128).nullable().default(null),
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
  /** 隧道本地端口；null = 未分配（T4 分配后写入） */
  localPort: PORT_SCHEMA.nullable().default(null),
  /** 显式私钥路径；null = 默认（agent 优先，设计文档 §7.3） */
  identityFile: z.string().trim().max(512).nullable().default(null)
})

export const HttpInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('http'),
  /**
   * 直连端点。存归一化 baseUrl（`parseEndpointUrl` 输出的 baseUrl）；
   * userinfo / 查询串 / 锚点由 parseEndpointUrl 直接拒绝（设计文档 §7.4）。
   */
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

// ===== 创建输入（IPC 边界，.strict()：未知字段一律拒绝） =====

const createBaseFields = {
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 字符'),
  authMode: z.enum(AUTH_MODES).default('auto'),
  notes: z.string().trim().max(2000).optional()
}

export const CreateInstanceInputSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...createBaseFields,
      transport: z.literal('local'),
      dshVersion: z.string().trim().max(64).optional(),
      port: PORT_SCHEMA.optional(),
      profile: z.string().trim().max(128).optional(),
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
    profile: z.string().trim().max(128).nullable().optional(),
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
  updatedAt: string
}

/** T2 注册的 CRUD 通道；start/stop/openView、auth:* 在其任务内追加（实现计划 §4） */
export const INSTANCE_IPC = {
  list: 'instances:list',
  get: 'instances:get',
  create: 'instances:create',
  update: 'instances:update',
  delete: 'instances:delete'
} as const

export type IpcErrorCode = 'invalid-input' | 'not-found' | 'io-error' | 'internal'

/** IPC 统一响应信封：错误码稳定，文案由渲染层按码表映射（PRD §8） */
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

/**
 * SSH `host[:port]` / `[v6]:port` 组合形式拆分。
 * 纯主机名 / 别名 / 裸 IPv6（含冒号但非 host:port 形态）原样返回，端口取 fallbackPort。
 */
export function splitSshHostPort(host: string, fallbackPort: number): { host: string; port: number } {
  const plain = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(host)
  if (plain) {
    const port = Number(plain[2] ?? '')
    if (port >= 1 && port <= 65535) return { host: plain[1] ?? '', port }
  }
  const bracketed = /^\[([0-9a-fA-F:]+)\]:(\d{1,5})$/.exec(host)
  if (bracketed) {
    const port = Number(bracketed[2] ?? '')
    if (port >= 1 && port <= 65535) return { host: bracketed[1] ?? '', port }
  }
  return { host, port: fallbackPort }
}