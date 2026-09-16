import { describe, expect, it } from 'vitest'
import { basePathOf, buildOpenViewPlan, classifyViewResponse } from './open-view-plan'

const COOKIE = { name: 'dsh_auth', value: 'tok', expiresAt: null }

describe('buildOpenViewPlan（装配层:URL → origin/basePath/cookie）', () => {
  it('带路径实例:basePath 为路径本身(不是默认根)', () => {
    const plan = buildOpenViewPlan('https://gw.example.com/dsh/?token=x', COOKIE)
    expect(plan).toEqual({
      url: 'https://gw.example.com/dsh/?token=x',
      origin: 'https://gw.example.com',
      basePath: '/dsh',
      cookie: COOKIE
    })
  })

  it('根路径实例:basePath 为 /', () => {
    const plan = buildOpenViewPlan('http://127.0.0.1:8002/?token=abc', COOKIE)
    expect(plan.basePath).toBe('/')
    expect(plan.origin).toBe('http://127.0.0.1:8002')
    // URL 原样保留(不重建,避免丢掉 ?token=)
    expect(plan.url).toBe('http://127.0.0.1:8002/?token=abc')
  })

  it('原样保留 URL(不因拼 origin+basePath 丢掉查询串)', () => {
    const plan = buildOpenViewPlan('http://127.0.0.1:8002/dsh/?token=abc', COOKIE)
    expect(plan.url).toContain('token=abc')
  })

  it('无会话:cookie 为 null 但仍给出 origin/basePath', () => {
    const plan = buildOpenViewPlan('https://gw.example.com/dsh/', null)
    expect(plan.cookie).toBeNull()
    expect(plan.basePath).toBe('/dsh')
  })

  it('URL 不可解析:origin 为空且 cookie 置 null(不写坏分区)', () => {
    const plan = buildOpenViewPlan('not a url', COOKIE)
    expect(plan.origin).toBe('')
    expect(plan.cookie).toBeNull()
    expect(plan.basePath).toBe('/')
  })

  it('basePathOf:多级路径与尾斜杠', () => {
    expect(basePathOf('https://h/a/b/?x=1')).toBe('/a/b')
    expect(basePathOf('https://h/dsh')).toBe('/dsh')
    expect(basePathOf('https://h/')).toBe('/')
    expect(basePathOf('https://h')).toBe('/')
  })
})

describe('classifyViewResponse（装配层:响应 → 认证信号,basePath 来自 plan）', () => {
  const nav = (location: string, statusCode = 302) => ({
    statusCode,
    headers: { location },
    resourceType: 'mainFrame'
  })

  it('带路径实例的 302 → /dsh/login 必须产生 session-expired', () => {
    const plan = buildOpenViewPlan('https://gw.example.com/dsh/', COOKIE)
    expect(classifyViewResponse(plan, nav('/dsh/login'))).toBe('session-expired')
  })

  it('带路径实例的 302 → /dsh/otp/verify 与 /dsh/onboarding', () => {
    const plan = buildOpenViewPlan('https://gw.example.com/dsh/', COOKIE)
    expect(classifyViewResponse(plan, nav('/dsh/otp/verify'))).toBe('needs-otp')
    expect(classifyViewResponse(plan, nav('/dsh/onboarding'))).toBe('needs-onboarding')
  })

  it('根路径实例的 302 → /login', () => {
    const plan = buildOpenViewPlan('http://127.0.0.1:8002/', COOKIE)
    expect(classifyViewResponse(plan, nav('/login'))).toBe('session-expired')
  })

  it('其它 basePath 的登录跳转不误判(归属校验仍生效)', () => {
    const plan = buildOpenViewPlan('https://gw.example.com/dsh/', COOKIE)
    expect(classifyViewResponse(plan, nav('/other/login'))).toBeNull()
  })

  it('401 JSON 判为会话失效;子资源 302 不算', () => {
    const plan = buildOpenViewPlan('https://gw.example.com/dsh/', COOKIE)
    expect(
      classifyViewResponse(plan, {
        statusCode: 401,
        headers: { 'content-type': 'application/json' },
        resourceType: 'xhr'
      })
    ).toBe('session-expired')
    expect(
      classifyViewResponse(plan, {
        statusCode: 302,
        headers: { location: '/dsh/login' },
        resourceType: 'script'
      })
    ).toBeNull()
  })
})
