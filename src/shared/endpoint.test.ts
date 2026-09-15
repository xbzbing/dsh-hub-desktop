import { describe, expect, it } from 'vitest'
import {
  EndpointParseError,
  isLoopbackHost,
  isSameEndpoint,
  parseEndpointUrl,
  tryParseEndpoint
} from './endpoint'

/** 取失败原因码；成功则让测试失败并给出可读原因 */
function codeOf(input: string): string {
  try {
    parseEndpointUrl(input)
  } catch (error) {
    if (error instanceof EndpointParseError) return error.code
    throw error
  }
  throw new Error(`期望解析失败，但 ${JSON.stringify(input)} 解析成功了`)
}

describe('parseEndpointUrl / 正常输入', () => {
  it('解析带显式端口与协议的地址', () => {
    expect(parseEndpointUrl('http://127.0.0.1:3080')).toEqual({
      origin: 'http://127.0.0.1:3080',
      scheme: 'http',
      host: '127.0.0.1',
      hostport: '127.0.0.1:3080',
      port: 3080,
      pathname: '/',
      baseUrl: 'http://127.0.0.1:3080'
    })
  })

  it('省略协议时按 http 补全', () => {
    expect(parseEndpointUrl('127.0.0.1:3080').baseUrl).toBe('http://127.0.0.1:3080')
  })

  it('省略协议的主机名（内网域名）按 http 补全', () => {
    const endpoint = parseEndpointUrl('dsh.internal:3080')
    expect(endpoint.scheme).toBe('http')
    expect(endpoint.host).toBe('dsh.internal')
    expect(endpoint.port).toBe(3080)
  })

  it('https 未写端口时补 443，且不写进 hostport', () => {
    const endpoint = parseEndpointUrl('https://dsh.example.com')
    expect(endpoint.port).toBe(443)
    expect(endpoint.hostport).toBe('dsh.example.com')
    expect(endpoint.origin).toBe('https://dsh.example.com')
  })

  it('显式写出的默认端口被归一化掉（不产生两种写法）', () => {
    expect(parseEndpointUrl('http://dsh.example.com:80').baseUrl).toBe('http://dsh.example.com')
    expect(parseEndpointUrl('https://dsh.example.com:443').baseUrl).toBe('https://dsh.example.com')
  })

  it('协议与主机名大小写归一化', () => {
    const endpoint = parseEndpointUrl('HTTP://DSH.Example.COM:3080')
    expect(endpoint.scheme).toBe('http')
    expect(endpoint.host).toBe('dsh.example.com')
    expect(endpoint.baseUrl).toBe('http://dsh.example.com:3080')
  })

  it('去掉首尾空白与结尾斜杠', () => {
    expect(parseEndpointUrl('  http://dsh.example.com:3080  ').baseUrl).toBe(
      'http://dsh.example.com:3080'
    )
    expect(parseEndpointUrl('http://dsh.example.com:3080///').pathname).toBe('/')
  })

  it('保留反代子路径并去掉其结尾斜杠', () => {
    const endpoint = parseEndpointUrl('https://gw.example.com/dsh/')
    expect(endpoint.pathname).toBe('/dsh')
    expect(endpoint.baseUrl).toBe('https://gw.example.com/dsh')
  })

  it('IPv6 字面量：host 去方括号，hostport 保留', () => {
    const withPort = parseEndpointUrl('http://[::1]:3080')
    expect(withPort.host).toBe('::1')
    expect(withPort.hostport).toBe('[::1]:3080')
    expect(withPort.origin).toBe('http://[::1]:3080')

    const withoutPort = parseEndpointUrl('https://[2001:db8::1]')
    expect(withoutPort.port).toBe(443)
    expect(withoutPort.hostport).toBe('[2001:db8::1]')
  })
})

describe('parseEndpointUrl / 非法输入', () => {
  it('空输入与纯空白判为 empty', () => {
    expect(codeOf('')).toBe('empty')
    expect(codeOf('   ')).toBe('empty')
  })

  it('非 http(s) 协议判为 unsupported-scheme', () => {
    expect(codeOf('ftp://dsh.example.com')).toBe('unsupported-scheme')
    expect(codeOf('file:///tmp/dsh')).toBe('unsupported-scheme')
  })

  it('缺主机判为 missing-host', () => {
    expect(codeOf('http://')).toBe('missing-host')
    expect(codeOf('http:///only-path')).toBe('missing-host')
  })

  it('内嵌用户名密码判为 credentials-not-allowed', () => {
    expect(codeOf('http://user:secret@127.0.0.1:3080')).toBe('credentials-not-allowed')
    expect(codeOf('http://token@127.0.0.1:3080')).toBe('credentials-not-allowed')
  })

  it('查询参数与锚点一律拒绝', () => {
    expect(codeOf('http://127.0.0.1:3080/?token=abc')).toBe('query-not-supported')
    expect(codeOf('http://127.0.0.1:3080/#/home')).toBe('hash-not-supported')
  })

  it('端口 0 判为 invalid-port', () => {
    expect(codeOf('http://127.0.0.1:0')).toBe('invalid-port')
  })

  it('端口越界与畸形地址判为 malformed', () => {
    expect(codeOf('http://127.0.0.1:70000')).toBe('malformed')
    expect(codeOf('http://[::1')).toBe('malformed')
  })

  it('抛出的错误携带稳定 code 与原始输入', () => {
    try {
      parseEndpointUrl('ftp://dsh.example.com')
      throw new Error('期望抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(EndpointParseError)
      const parseError = error as EndpointParseError
      expect(parseError.code).toBe('unsupported-scheme')
      expect(parseError.input).toBe('ftp://dsh.example.com')
      expect(parseError.name).toBe('EndpointParseError')
    }
  })
})

describe('tryParseEndpoint', () => {
  it('成功时返回 ok + endpoint', () => {
    const result = tryParseEndpoint('127.0.0.1:3080')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.endpoint.baseUrl).toBe('http://127.0.0.1:3080')
  })

  it('失败时返回 ok=false + code，不抛异常', () => {
    const result = tryParseEndpoint('ftp://dsh.example.com')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unsupported-scheme')
      expect(result.message).not.toBe('')
    }
  })
})

describe('isSameEndpoint', () => {
  it('默认端口与省略写法的端点视为同一个', () => {
    expect(
      isSameEndpoint(parseEndpointUrl('http://DSH.example.com:80'), parseEndpointUrl('dsh.example.com'))
    ).toBe(true)
  })

  it('不同端口或不同子路径视为不同端点', () => {
    expect(
      isSameEndpoint(parseEndpointUrl('http://dsh.example.com'), parseEndpointUrl('http://dsh.example.com:3080'))
    ).toBe(false)
    expect(
      isSameEndpoint(
        parseEndpointUrl('https://gw.example.com/dsh'),
        parseEndpointUrl('https://gw.example.com')
      )
    ).toBe(false)
  })
})

describe('isLoopbackHost', () => {
  it('识别回环写法', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'dsh.localhost']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
  })

  it('不把远端地址与监听通配地址当作回环', () => {
    for (const host of ['dsh.example.com', '10.0.0.1', '192.168.1.9', '0.0.0.0', '::', '127.0.0.1.example.com']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})
