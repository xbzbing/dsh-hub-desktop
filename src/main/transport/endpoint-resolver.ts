/**
 * Endpoint Resolver（T4,设计文档 §2.4 / 实现计划 §3.1）—— 纯函数，不 import electron。
 *
 * 「实例 → 最终端点 URL」的唯一出口：local 由运行时解析就绪 URL、ssh 由隧道本地
 * 监听口拼回环地址、http 直连取归一化 baseUrl。所有下游（健康探测 / 打开视图 /
 * 认证探测）只从这里拿 URL，不允许各自拼。
 *
 * 目标地址拼装原则：一律本机回环 —— 远端不可达的网段/主机名感知只存在于
 * ssh/http 端点自身，hub 的探测面永远是 `127.0.0.1:<localPort>`（设计 §4.2）。
 */
import type { HttpInstance, InstanceRecord } from '@shared/contracts'
import { parseEndpointUrl } from '@shared/endpoint'

/** ssh 隧道就绪后的本地端点（探测 / 开窗都打这里） */
export function sshTunnelEndpoint(localPort: number): string {
  return `http://127.0.0.1:${localPort}/`
}

/** http 直连：归一化端点 + 根路径（`/` 用于 §4.3 探测） */
export function httpDirectEndpoint(instance: HttpInstance): string {
  const endpoint = parseEndpointUrl(instance.endpointUrl)
  return `${endpoint.baseUrl}/`
}

export type ResolvedEndpoint = ReturnType<typeof sshTunnelEndpoint>

/**
 * 「实例 → 认证探测端点」。
 *
 * 设计 §2.4 明确把**认证探测**列为端点解析器的下游之一,所以三种传输各有归宿:
 * - `http`:直连端点本身就是网关入口;
 * - `ssh`:隧道本地口 `127.0.0.1:<localPort>` 就是网关入口(**隧道未就绪时无法认证 → null**);
 * - `local`:hub 自己 spawn 的 dsh web 走 BrowserAuth(令牌已在就绪 URL 里),不经网关登录 → null。
 *
 * 评审 R7:此前 ssh 直接返回 null,导致隧道后的网关实例「登录」按钮是死的
 * (点开面板既无状态也无提示)。
 */
export function authEndpointOf(
  record: InstanceRecord,
  tunnelLocalPort: number | undefined
): string | null {
  if (record.transport === 'http') return record.endpointUrl
  if (record.transport === 'ssh') {
    return tunnelLocalPort === undefined ? null : sshTunnelEndpoint(tunnelLocalPort)
  }
  return null
}
