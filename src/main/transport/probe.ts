/**
 * 通用健康探测（T4,设计文档 §4.3）—— 不 import electron（全局规则 5）。
 *
 * 任何传输解析出的端点统一用同一套 HealthyProbe：
 * `GET <endpoint>/`，任意 HTTP 响应（200/302/401）即「传输就绪」；
 * ECONNREFUSED/超时 = 未就绪；进程退出 = 传输死亡（由各传输层自己判定）。
 * 认证层随后再区分 302→/login（网关）与 200（无认证）；探测频率：连接期 500ms。
 */

export type HealthProbe = (url: string, timeoutMs: number) => Promise<boolean>

export const httpHealthProbe: HealthProbe = async (url, timeoutMs) => {
  try {
    // redirect:'manual' —— §4.3「任意 HTTP 响应(200/302/401)即就绪」:
    // 若跟随重定向,302 到探测面不可达的外部 IdP 会被判「未就绪」→ 隧道被误杀并进入重连死循环
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    })
    // §4.3：任意 HTTP 响应（200/302/401）都表示传输已就绪
    return response.status >= 100 && response.status < 600
  } catch {
    return false
  }
}

/** 短暂等待（unref 不挂住进程；探测重试间隔用） */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}