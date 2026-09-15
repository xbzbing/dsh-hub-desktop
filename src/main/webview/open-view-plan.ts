/**
 * 打开实例视图的「接线计划」（T8/T9 装配层）—— 纯函数,不 import electron。
 *
 * 存在的理由:三轮独立评审用变异测试反复证明,装配文件 `src/main/index.ts` 没有直接
 * 测试,而单元测试又对依赖打桩,于是这类**生产接线**能在测试全绿的情况下回归:
 * - 「分区 Cookie 注入」被改成恒 `null` → 全套用例仍绿;
 * - 「拦截层带上 basePath」被删掉 → 带路径实例(`/dsh`)的 `302 → <basePath>/login`
 *   永远匹配不上,`session-expired` 不再产生 → 全套用例仍绿。
 *
 * 因此把「URL → (origin, basePath, cookie)」与「响应 → 认证信号」这两步从 index.ts
 * 里抽出来,让它们由同一份 `plan` 驱动,从而可被直接测试 —— index.ts 只负责把
 * electron 的细节喂进来。
 */
import type { AuthSignal } from './intercept'
import { classifyAuthSignal } from './intercept'
import { originOf } from './session-cookie'

/** 主进程持有的会话 Cookie(与 AuthRegistry.sessionCookie 同构) */
export interface SessionCookie {
  name: string
  value: string
  expiresAt: number | null
}

export interface OpenViewPlan {
  /** 确切要加载的 URL(可能带 `?token=...`,不得重建) */
  url: string
  /** 端点 origin(无法解析时为 '') */
  origin: string
  /** 端点 basePath('/' 或 '/dsh');拦截判定与 Cookie 写入都用它 */
  basePath: string
  /** 要注入分区会话的 Cookie;origin 不可解析时为 null(避免写坏分区) */
  cookie: SessionCookie | null
}

/** 从 URL 取 basePath(去掉尾斜杠;空则 '/') */
export function basePathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/'
  } catch {
    return '/'
  }
}

/**
 * 由视图 URL 与会话 Cookie 构造接线计划。
 * `origin` 不可解析(cookie 无处可写、拦截也无法归属)时把 cookie 置为 null。
 */
export function buildOpenViewPlan(url: string, sessionCookie: SessionCookie | null): OpenViewPlan {
  const origin = originOf(url)
  return {
    url,
    origin: origin ?? '',
    basePath: basePathOf(url),
    cookie: origin ? sessionCookie : null
  }
}

/** electron `onHeadersReceived` 里我们真正用到的字段 */
export interface ViewResponseDetails {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  resourceType?: string
}

/**
 * 判定一次实例视图响应是否构成认证信号。
 *
 * **basePath 必须来自 plan**:网关 302 到的是 `<basePath>/login`,默认 '/' 只能
 * 匹配根路径实例 —— 带路径实例(如 `/dsh`)会完全失去会话失效信号。
 */
export function classifyViewResponse(
  plan: OpenViewPlan,
  details: ViewResponseDetails
): AuthSignal | null {
  return classifyAuthSignal(
    {
      statusCode: details.statusCode,
      headers: details.headers,
      resourceType: details.resourceType
    },
    plan.basePath
  )
}
