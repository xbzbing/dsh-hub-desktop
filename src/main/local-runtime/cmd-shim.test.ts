import { describe, expect, it } from 'vitest'
import { resolveCmdShim } from './cmd-shim'

const NPM_STYLE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\dush\\bin\\dush.js" %*'
].join('\r\n')

const OLDER_STYLE_SHIM =
  '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\duush\\bin\\duush.js" %*\r\n'

describe('resolveCmdShim（win32 .cmd 入口脚本解析）', () => {
  const exists = (path: string): boolean => path.includes('node_modules')

  it('cmd-shim 标准形态：%dp0% 相对路径按 .cmd 所在目录解析', () => {
    const script = resolveCmdShim('C:\\Users\\t\\AppData\\Roaming\\npm\\dush.cmd', {
      read: () => NPM_STYLE_SHIM,
      exists
    })
    expect(script?.replace(/\\/g, '/')).toBe(
      'C:/Users/t/AppData/Roaming/npm/node_modules/dush/bin/dush.js'
    )
  })

  it('旧式 %~dp0% 形态同样可解析', () => {
    const script = resolveCmdShim('C:\\Users\\t\\AppData\\Roaming\\npm\\duush.cmd', {
      read: () => OLDER_STYLE_SHIM,
      exists
    })
    expect(script?.replace(/\\/g, '/')).toBe(
      'C:/Users/t/AppData/Roaming/npm/node_modules/duush/bin/duush.js'
    )
  })

  it('无入口引用 / 入口不存在 / shim 不可读 → null（调用方快速失败）', () => {
    expect(
      resolveCmdShim('C:\\x\\a.cmd', { read: () => '@ECHO off\r\nnothing\r\n', exists })
    ).toBeNull()
    expect(
      resolveCmdShim('C:\\x\\a.cmd', {
        read: () => '"%dp0%\\node_modules\\gone\\bin\\gone.js"',
        exists: () => false
      })
    ).toBeNull()
    expect(
      resolveCmdShim('C:\\x\\a.cmd', {
        read: () => {
          throw new Error('ENOENT')
        },
        exists
      })
    ).toBeNull()
  })
})
