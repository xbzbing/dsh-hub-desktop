import { describe, expect, it } from 'vitest'
import { isAllowedInstanceNavigation } from './window-host-policy'

describe('isAllowedInstanceNavigation（实例窗口外跳拦截 §6.6）', () => {
  const origin = 'http://127.0.0.1:30000/?token=abc'

  it('同源回环导航放行（含路径与查询）', () => {
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30000/', origin)).toBe(true)
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30000/api/jobs', origin)).toBe(true)
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30000/?token=abc#/chat', origin)).toBe(true)
  })

  it('回环别名（localhost / ::1 / 127.1 省略写法）同端口放行', () => {
    expect(isAllowedInstanceNavigation('http://localhost:30000/', origin)).toBe(true)
    expect(isAllowedInstanceNavigation('http://127.1:30000/', origin)).toBe(true)
    expect(isAllowedInstanceNavigation('http://[::1]:30000/', origin)).toBe(true)
  })

  it('外部 http(s) 顶层导航一律拒绝', () => {
    expect(isAllowedInstanceNavigation('https://evil.example.com/phish', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('http://192.168.1.5:30000/', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('http://10.0.0.1:30000/', origin)).toBe(false)
  })

  it('跨端口回环拒绝（防串到其他实例 / 本机其他服务）', () => {
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30001/', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('http://127.0.0.1:80/', origin)).toBe(false)
  })

  it('非 http(s) 协议拒绝（file / data / javascript / about）', () => {
    expect(isAllowedInstanceNavigation('file:///etc/passwd', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('data:text/html,<script>1</script>', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('javascript:alert(1)', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('about:blank', origin)).toBe(false)
  })

  it('非法 / 不可解析的 URL 拒绝', () => {
    expect(isAllowedInstanceNavigation('not a url', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30000/', 'not a url')).toBe(false)
  })
})