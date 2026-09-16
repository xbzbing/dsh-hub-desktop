import { describe, expect, it } from 'vitest'
import { isAllowedInstanceNavigation } from './window-host-policy'

describe('isAllowedInstanceNavigation（实例窗口外跳拦截 ）', () => {
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
describe('isAllowedInstanceNavigation（用户#4:远程 http 实例的登录页导航）', () => {
  const remote = 'https://gw.example.com/dsh/?token=abc'

  it('同 origin 的网关登录页 / OTP / onboarding / 登录提交一律放行', () => {
    // #4 的复现场景:302 落到 <origin>/login,用户输入密码提交 form → 顶层导航
    expect(isAllowedInstanceNavigation('https://gw.example.com/login', remote)).toBe(true)
    expect(isAllowedInstanceNavigation('https://gw.example.com/login/auth', remote)).toBe(true)
    expect(isAllowedInstanceNavigation('https://gw.example.com/dsh/otp/verify', remote)).toBe(true)
    expect(isAllowedInstanceNavigation('https://gw.example.com/dsh/onboarding/password', remote)).toBe(true)
    expect(isAllowedInstanceNavigation('https://gw.example.com/dsh/', remote)).toBe(true)
  })

  it('http(明文)远程实例的同 origin 导航同样放行', () => {
    const plain = 'http://remote.internal.example.com/dsh/'
    expect(isAllowedInstanceNavigation('http://remote.internal.example.com/login', plain)).toBe(true)
  })

  it('远程实例:跨 origin(外部钓鱼/其他网关)一律拒绝 —— 分区 Cookie 不出实例服务', () => {
    expect(isAllowedInstanceNavigation('https://evil.example.com/phish', remote)).toBe(false)
    expect(isAllowedInstanceNavigation('https://other-gw.example.com/login', remote)).toBe(false)
    expect(isAllowedInstanceNavigation('http://gw.example.com.evil.io/login', remote)).toBe(false)
  })

  it('远程实例:同 host 跨协议/跨端口拒绝(origin 不等价)', () => {
    expect(isAllowedInstanceNavigation('http://gw.example.com/login', remote)).toBe(false)
    expect(isAllowedInstanceNavigation('https://gw.example.com:8443/login', remote)).toBe(false)
  })

  it('回环实例语义不:跨端口/外部仍拒绝(见上一组用例)', () => {
    const loopback = 'http://127.0.0.1:30000/?token=abc'
    expect(isAllowedInstanceNavigation('https://gw.example.com/login', loopback)).toBe(false)
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30001/', loopback)).toBe(false)
  })
})
