import { createTranslator } from '@shared/i18n'
import { describe, expect, it } from 'vitest'
import { localizeIpcMessage } from './ipc-message'

const zh = createTranslator('zh')
const en = createTranslator('en')

describe('localizeIpcMessage', () => {
  it('把稳定文案 key 换成当前语言', () => {
    expect(localizeIpcMessage(zh, 'proxy.errPortMax')).toBe('代理端口最大 65535')
    expect(localizeIpcMessage(en, 'proxy.errPortMax')).toBe('Proxy port must be at most 65535')
  })

  it('保留路径前缀,只替换其后的 key', () => {
    expect(localizeIpcMessage(zh, 'proxy.port: proxy.errPortNumber')).toBe(
      'proxy.port: 代理端口必须是数字'
    )
  })

  it('普通错误文案原样返回', () => {
    expect(localizeIpcMessage(zh, '连接超时')).toBe('连接超时')
    expect(localizeIpcMessage(zh, 'proxy.port: 连接超时')).toBe('proxy.port: 连接超时')
  })

  it('逐段处理以 "; " 拼接的多条错误', () => {
    expect(
      localizeIpcMessage(zh, 'proxy.host: proxy.errHostRequired; proxy.password: 连接超时')
    ).toBe('proxy.host: 代理主机不能为空; proxy.password: 连接超时')
  })
})
