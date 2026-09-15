/**
 * IPC 单点注册（T2）—— 所有 ipcMain.handle 集中于此，入参一律过 zod 边界校验。
 *
 * 设计依据：`docs/desktop-implementation-plan.md` §4 —— 渲染进程只能调用这里注册的
 * 白名单通道（preload 再暴露一层）；非法入参返回 `IpcResult` 错误信封而非抛异常，
 * 渲染层按稳定错误码映射文案（PRD §8）。
 */
import { app, ipcMain } from 'electron'
import { z } from 'zod'
import { EndpointParseError } from '@shared/endpoint'
import { IPC, type AppInfo, type PingResult } from '@shared/bridge'
import {
  AUTH_IPC,
  CreateInstanceInputSchema,
  formatZodIssues,
  HTTP_IPC,
  INSTANCE_IPC,
  INSTANCE_RUNTIME_IPC,
  PatchInstanceSchema,
  SSH_IPC,
  SETTINGS_IPC,
  SshKeyPreviewInputSchema,
  VAULT_IPC,
  VaultPolicySchema,
  type HostKeyDecision,
  type AuthStateSnapshot,
  type HttpAuthDetection,
  type InstanceRecord,
  type VaultPolicy,
  type VaultStatusSnapshot,
  type InstanceSummary,
  type IpcResult
} from '@shared/contracts'
import { detectDraftEndpoint } from '../transport/http-endpoint'
import type { HttpEndpointManager } from '../transport/http-endpoint'
import { resolveSshKeyPreview } from '../ssh/key-preview'
import type { PromptBroker } from '../ssh/prompt-broker'
import type { AuthRegistry } from '../auth/auth-registry'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import type { SshTunnelManager } from '../transport/ssh-tunnel'
import { InstanceStoreError, type InstanceStore } from '../registry/instance-store'
import { DataDirOpenError } from '../shell/open-data-dir'
import type { Vault } from '../vault/vault'
import type { SettingsStore } from '../settings/settings-store'
import { SettingsSchema } from '@shared/settings'
import type { Settings } from '@shared/settings'
import type { AuditEntry } from '../audit/audit-log'

export interface IpcDeps {
  /** 本地运行时（T3）；SSH / HTTP 传输在各自任务内接入同一状态通道 */
  runtime: LocalRuntimeManager
  /** SSH 隧道传输（T4）；HTTP 直连在 T6 */
  tunnels: SshTunnelManager
  /**
   * 打开实例视图窗口（electron 侧实现，便于 register 单测注入假实现）。
   * 返回 Promise：加载前的分区 Cookie 注入是异步的（§6.2 顺序纪律），
   * 调用方必须 await —— 否则 IPC 会在视图真正就绪前返回。
   */
  openInstanceView: (instance: InstanceRecord, url: string) => Promise<void>
  /** T5 用户提示代理（指纹确认 / 口令输入） */
  prompts: PromptBroker
  /** T6 HTTP 直连传输 */
  http: HttpEndpointManager
  /** T8 每实例认证客户端 */
  auth: AuthRegistry
  /** T9 清理实例分区会话 Cookie(登出/切换账号时;缺省不清理,便于单测) */
  clearPartitionSession?: (instanceId: string) => Promise<void>
  /**
   * T10 凭据保险库(§7.2)。默认不存任何东西;只有实例策略显式勾选后
   * 才在登录成功时写入,勾选取消即忘掉。
   */
  vault: Vault
  /** T11 应用设置(非敏感偏好) */
  settings: SettingsStore
  /**
   * T11 设置变更后的原生副作用(开机自启 / 托盘 / 通知偏好)。
   * 缺省不执行(单测);落盘由本模块负责,副作用交给装配层。
   */
  onSettingsChanged?: (settings: Settings) => void
  /**
   * T11 三审 Finding 1:打开应用数据目录(设置页「打开」按钮)。
   *
   * **签名上没有路径参数**——目录由装配层自行解析(`DSH_HUB_DATA_DIR` /
   * `app.getPath('userData')`),渲染层无从指定,故不可能成为任意文件打开原语。
   * 缺省时该通道返回 internal 错误信封(单测不装配)。
   */
  openDataDir?: () => Promise<void>
  /**
   * T10 审计(§7.5)。只接收白名单字段(见 `audit/audit-log.ts`),缺省不审计(单测)。
   * 审计写入本身异步且失败隔离,不阻塞业务。
   */
  audit?: (entry: AuditEntry) => void
}

async function wrap<T>(task: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await task() }
  } catch (error) {
    if (error instanceof InstanceStoreError) {
      return { ok: false, code: error.code, message: error.message }
    }
    if (error instanceof z.ZodError) {
      return { ok: false, code: 'invalid-input', message: formatZodIssues(error) }
    }
    // 端点解析失败属输入问题(不是内部错误):与 instances:create 的 tryParseEndpoint 口径一致
    if (error instanceof EndpointParseError) {
      return { ok: false, code: 'invalid-input', message: error.message }
    }
    // 打开数据目录失败:带稳定错误码(io-error/internal)显式回报,
    // 不让「打不开」被吞成成功或未处理 rejection(T11 三审 Finding 1)
    if (error instanceof DataDirOpenError) {
      return { ok: false, code: error.code, message: error.message }
    }
    // 内部错误不透传细节(可能含 fs 路径),只记主进程日志
    console.error('[ipc] 未预期错误：', error)
    return { ok: false, code: 'internal', message: '内部错误，请查看主进程日志' }
  }
}

function parseId(id: unknown): string {
  return z.uuid().parse(id)
}

function toSummary(record: InstanceRecord): InstanceSummary {
  const address =
    record.transport === 'local'
      ? `127.0.0.1:${record.port ?? '—'}`
      : record.transport === 'ssh'
        ? `${record.host}:${record.remotePort}`
        : record.endpointUrl
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    authMode: record.authMode,
    address,
    updatedAt: record.updatedAt
  }
}

export function registerIpc(store: InstanceStore, deps: IpcDeps): void {
  const processVersions = process.versions as NodeJS.ProcessVersions & { electron?: string }

  // 全部通道统一返回 IpcResult 信封：错误码稳定，渲染层按码表映射文案（PRD §8）
  ipcMain.handle(IPC.info, (): Promise<IpcResult<AppInfo>> =>
    wrap((): AppInfo => ({
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      chrome: process.versions.chrome,
      electron: processVersions.electron ?? '',
      node: process.versions.node,
      userDataPath: app.getPath('userData')
    }))
  )

  ipcMain.handle(IPC.ping, (_event, message: unknown): Promise<IpcResult<PingResult>> =>
    wrap((): PingResult => {
      const echo = typeof message === 'string' && message !== '' ? message : null
      return { echo, at: Date.now() }
    })
  )

  // —— 实例注册表 CRUD ——

  ipcMain.handle(INSTANCE_IPC.list, (): Promise<IpcResult<InstanceSummary[]>> =>
    wrap(() => store.list().then((records) => records.map(toSummary)))
  )

  ipcMain.handle(INSTANCE_IPC.get, (_event, id: unknown): Promise<IpcResult<InstanceRecord | null>> =>
    wrap(() => store.get(parseId(id)))
  )

  ipcMain.handle(INSTANCE_IPC.create, (_event, input: unknown): Promise<IpcResult<InstanceRecord>> =>
    wrap(() => store.create(CreateInstanceInputSchema.parse(input)))
  )

  ipcMain.handle(
    INSTANCE_IPC.update,
    (_event, id: unknown, patch: unknown): Promise<IpcResult<InstanceRecord>> =>
      wrap(() => store.update(parseId(id), PatchInstanceSchema.parse(patch)))
  )

  ipcMain.handle(
    INSTANCE_IPC.delete,
    (_event, id: unknown): Promise<IpcResult<{ removed: boolean }>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        // 详情页文案承诺「删除运行中的实例会先停止其进程」:先回收进程树再移除记录,
        // 否则 dsh/ssh 进程继续存活(独占端口与 DSH_HOME),窗口也无 stopped 事件可回收
        const record = await store.get(instanceId)
        if (record?.transport === 'ssh') await deps.tunnels.stop(instanceId)
        else if (record?.transport === 'http') await deps.http.stop(instanceId)
        else if (record?.transport === 'local') await deps.runtime.stop(instanceId)
        // T9:删除实例一并清该分区会话与认证客户端(不留悬挂会话)
        deps.auth.forget(instanceId)
        // T10:实例没了,已记住的凭据与勾选策略一并清掉
        await deps.vault.forgetInstance(instanceId)
        await deps.clearPartitionSession?.(instanceId).catch(() => undefined)
        return { removed: await store.remove(instanceId) }
      })
  )

  // —— 实例运行时控制（T3 本地 / T4 SSH）：start/stop 立即返回，进展经 `instance:status` 回推 ——

  ipcMain.handle(INSTANCE_RUNTIME_IPC.start, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instance = await store.get(parseId(id))
      if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)
      if (instance.transport === 'local') {
        // 不 await：安装/启动可能耗时数十秒，进展与失败都走状态事件
        void deps.runtime.start(instance)
        return null
      }
      if (instance.transport === 'ssh') {
        void deps.tunnels.start(instance)
        return null
      }
      if (instance.transport === 'http') {
        void deps.http.start(instance)
        return null
      }
      // 契约层已限定三种 transport;此处为穷尽性兜底(TS 已收窄为 never)
      throw new InstanceStoreError('invalid-input', '未知的传输类型')
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.stop, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const record = await store.get(instanceId)
      if (record?.transport === 'ssh') await deps.tunnels.stop(instanceId)
      else if (record?.transport === 'http') await deps.http.stop(instanceId)
      else await deps.runtime.stop(instanceId) // local 或不存在:runtime.stop 幂等
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.openView, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const instance = await store.get(instanceId)
      if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)
      // 状态按 transport 取:ssh 隧道状态只存在于 tunnels 管理器,
      // local 的只在 runtime;取错管理器会让 ssh 实例「已连接但打不开视图」(评审缺陷 A)
      const status =
        instance.transport === 'ssh'
          ? deps.tunnels.statusOf(instanceId)
          : instance.transport === 'http'
            ? deps.http.statusOf(instanceId)
            : deps.runtime.statusOf(instanceId)
      if (status?.status !== 'running' || !status.url) {
        throw new InstanceStoreError('invalid-state', '实例尚未运行，无法打开视图')
      }
      await deps.openInstanceView(instance, status.url)
      return null
    })
  )

  // —— SSH 辅助（T5）：密钥预览 + 指纹确认/口令回复 ——

  ipcMain.handle(SSH_IPC.keyPreview, (_event, input: unknown) =>
    wrap(() => {
      const parsed = SshKeyPreviewInputSchema.parse(input)
      return resolveSshKeyPreview({
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        identityFile: parsed.identityFile ?? null
      })
    })
  )

  ipcMain.handle(
    SSH_IPC.hostKeyReply,
    (_event, requestId: unknown, decision: unknown): Promise<IpcResult<null>> =>
      wrap(() => {
        const id = z.uuid().parse(requestId)
        const value = z.enum(['trust', 'reject']).parse(decision) as HostKeyDecision
        deps.prompts.replyHostKey(id, value)
        return null
      })
  )

  ipcMain.handle(
    SSH_IPC.hostKeyForget,
    (_event, input: unknown): Promise<IpcResult<null>> =>
      wrap(async () => {
        // 显式、破坏性的恢复动作(设计 §7.3):连接时指纹变化一律拒绝且不自动清理,
        // 只有用户主动「忘记该主机指纹」后,下一次连接才会重新走首次 TOFU 确认。
        const parsed = z.object({ instanceId: z.uuid() }).parse(input)
        const instance = await store.get(parsed.instanceId)
        if (!instance) {
          throw new InstanceStoreError('not-found', `实例不存在：${parsed.instanceId}`)
        }
        if (instance.transport !== 'ssh') {
          throw new InstanceStoreError('invalid-input', '只有 SSH 隧道实例才有主机指纹')
        }
        await deps.tunnels.forgetHostKey(instance)
        return null
      })
  )

  // —— 认证（T8）：状态流 + 登录提交（凭据只在主进程内存中流转） ——

  const authSnapshot = (
    state: Awaited<ReturnType<AuthRegistry['login']>>
  ): AuthStateSnapshot | null => (state === null ? null : (state as unknown as AuthStateSnapshot))

  /**
   * 写 vault 的「安静」包装:凭据记忆是**尽力而为**的附加动作,
   * 失败(磁盘满/钥匙串不可用)绝不能把一次成功的登录变成错误。
   */
  async function rememberQuietly(instanceId: string, password: string): Promise<void> {
    try {
      await deps.vault.rememberPassword(instanceId, password)
    } catch (error) {
      console.error('[register] 记住密码失败(登录已成功)：', error)
    }
  }

  /** vault 状态快照(渲染层据此显示降级告警与「已记住」标记) */
  function vaultSnapshot(): VaultStatusSnapshot {
    const status = deps.vault.status()
    const remembered = deps.vault.rememberedIds()
    // 用 policyIds 而非 rememberedIds:策略可以先于凭据存在(复审 F1)
    const policies: Record<string, VaultPolicy> = {}
    for (const id of deps.vault.policyIds()) {
      const policy = deps.vault.getPolicy(id)
      if (policy.rememberPassword || policy.rememberSession) policies[id] = policy
    }
    return {
      available: status.available,
      degraded: status.degraded,
      rememberedInstances: remembered,
      policies
    }
  }

  // probe:返回状态快照(探测结论经 auth:state 事件与 T6 detect 暴露;此处主要驱动 UI 阶段)
  ipcMain.handle(AUTH_IPC.probe, (_event, id: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      await deps.auth.probe(instanceId)
      return authSnapshot(deps.auth.stateOf(instanceId) as never)
    })
  )

  ipcMain.handle(
    AUTH_IPC.login,
    (_event, id: unknown, password: unknown, otp: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const pwd = z.string().min(1).max(1024).parse(password)
        // 验证码/备份码域:网关 TOTP 位数**可配**(`otpDigits`,默认 6,合法 4-10),
        // 备份码长度也可配(`backupCodeLength`,默认 8,合法 6-12)。
        // 因此下界必须是 4 —— 评审 R3:曾收紧到 min(6),会让 otpDigits=4|5 的实例
        // 完全无法登录(合法验证码被 zod 拒掉)。
        const code = z.string().trim().min(4).max(12).nullable().parse(otp ?? null)
        const state = await deps.auth.login(instanceId, pwd, code ?? undefined)
        // T10 §7.2:只有**登录成功**且用户显式勾选「记住密码」才写钥匙串。
        // 失败绝不写(否则一次错误输入会把错密码存进钥匙串);未勾选时 vault 自身也会拒绝。
        if (state?.phase === 'connected' && deps.vault.getPolicy(instanceId).rememberPassword) {
          await rememberQuietly(instanceId, pwd)
          deps.audit?.({ instanceId, event: 'vault-write', result: 'password' })
        }
        return authSnapshot(state)
      })
  )

  ipcMain.handle(AUTH_IPC.logout, (_event, id: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const snapshot = authSnapshot(await deps.auth.logout(instanceId))
      // T9:登出后必须清分区会话,否则 webview 仍带旧 Cookie 访问受保护页面
      await deps.clearPartitionSession?.(instanceId)
      deps.audit?.({ instanceId, event: 'session-revoked', result: 'logout' })
      deps.audit?.({ instanceId, event: 'cookie-cleared', result: 'logout' })
      return snapshot
    })
  )

  // —— T10 凭据保险库（§7.2）：只暴露状态/勾选/忘记/清空,没有「读出凭据」的通道 ——

  ipcMain.handle(VAULT_IPC.status, (): Promise<IpcResult<VaultStatusSnapshot>> =>
    wrap(() => vaultSnapshot())
  )

  ipcMain.handle(
    VAULT_IPC.setPolicy,
    (_event, id: unknown, policy: unknown): Promise<IpcResult<VaultPolicy>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const parsed = VaultPolicySchema.parse(policy)
        await deps.vault.setPolicy(instanceId, parsed)
        return parsed
      })
  )

  ipcMain.handle(
    VAULT_IPC.forget,
    (_event, id: unknown, target: unknown): Promise<IpcResult<VaultPolicy>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        // 缺省 = 两个都忘(UI 的「清除已记住的凭据」)
        const parsed = z
          .object({ password: z.boolean().optional(), session: z.boolean().optional() })
          .strict()
          .nullable()
          .parse(target ?? null)
        const dropPassword = parsed?.password ?? true
        const dropSession = parsed?.session ?? true
        if (dropPassword) await deps.vault.forgetPassword(instanceId)
        if (dropSession) await deps.vault.forgetSession(instanceId)
        // 忘记凭据即取消勾选:否则下一次登录又会把它写回来
        const policy = deps.vault.getPolicy(instanceId)
        const next: VaultPolicy = {
          rememberPassword: dropPassword ? false : policy.rememberPassword,
          rememberSession: dropSession ? false : policy.rememberSession
        }
        await deps.vault.setPolicy(instanceId, next)
        return next
      })
  )

  ipcMain.handle(VAULT_IPC.clear, (): Promise<IpcResult<VaultStatusSnapshot>> =>
    wrap(async () => {
      await deps.vault.clearAll()
      deps.audit?.({ event: 'vault-clear', result: 'ok' })
      return vaultSnapshot()
    })
  )

  // —— T11 应用设置（非敏感偏好;敏感项走 vault） ——

  ipcMain.handle(
    SETTINGS_IPC.get,
    (): Promise<IpcResult<Settings>> => wrap(() => deps.settings.read())
  )

  ipcMain.handle(
    SETTINGS_IPC.update,
    (_event, patch: unknown): Promise<IpcResult<Settings>> =>
      wrap(async () => {
        // 只接受已知字段的**部分**补丁;未知字段由 .strict() 拒绝。
        // 注意:`.partial()` 不会去掉字段自身的 `.default()`,会把未提交的字段也填上默认值 ——
        // 那会让「只改语言」的补丁顺带回写其它字段(并把用户的其它偏好重置)。
        // 因此这里先按未知字段校验,再**只挑出调用方真正给出的键**。
        const raw = z.record(z.string(), z.unknown()).parse(patch)
        SettingsSchema.partial().strict().parse(raw)
        const known = Object.keys(SettingsSchema.shape) as Array<keyof Settings>
        const provided: Partial<Settings> = {}
        for (const key of known) {
          if (key in raw) provided[key] = raw[key] as never
        }
        const next = await deps.settings.update(provided)
        // 副作用失败不能回滚设置(偏好已落盘);由装配层自行隔离错误
        deps.onSettingsChanged?.(next)
        return next
      })
  )

  // T11 三审 Finding 1:打开应用数据目录。
  // **签名上没有路径参数**,并用空元组 schema 把「多传参数」判为非法调用 ——
  // 目录只能由主进程自行解析,渲染层无法指定路径(见 `shell/open-data-dir.ts`)。
  ipcMain.handle(
    SETTINGS_IPC.openDataDir,
    (_event, ...args: unknown[]): Promise<IpcResult<null>> =>
      wrap(async () => {
        z.tuple([]).parse(args)
        if (!deps.openDataDir) throw new DataDirOpenError('internal', '打开数据目录不可用')
        await deps.openDataDir()
        return null
      })
  )

  ipcMain.handle(
    HTTP_IPC.detect,
    (_event, endpointUrl: unknown): Promise<IpcResult<HttpAuthDetection>> =>
      wrap(() => {
        const raw = z.string().trim().min(1).max(2048).parse(endpointUrl)
        return detectDraftEndpoint(raw)
      })
  )

  ipcMain.handle(
    SSH_IPC.askpassReply,
    (_event, requestId: unknown, secret: unknown): Promise<IpcResult<null>> =>
      wrap(() => {
        const id = z.uuid().parse(requestId)
        // 空串不是有效口令(UI 已 disabled,IPC 边界同样拒绝)
        const value = z
          .string()
          .max(4096)
          .nullable()
          .refine((v) => v === null || v.trim() !== '', '口令不能为空串')
          .parse(secret)
        deps.prompts.replyAskpass(id, value)
        return null
      })
  )
}
