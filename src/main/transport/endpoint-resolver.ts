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
import type { HttpInstance, SshInstance } from '@shared/contracts'
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

/** 仅编译期守卫：ssh 实例必须已分配 localPort 才能解析（契约权限在调用方校验） */
export function assertSshLocalPort(instance: SshInstance): number {
  if (instance.localPort === null) {
    throw new Error(`SSH 实例尚未分配隧道本地端口：${instance.id}`)
  }
  return instance.localPort
}