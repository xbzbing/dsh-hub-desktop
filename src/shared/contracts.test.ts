import { describe, expect, it } from 'vitest'
import { DSH_VERSION_IPC, DSH_VERSION_PROGRESS_EVENT, WORKSPACE_HOTKEY_EVENT } from './contracts'

/**
 * 运行时可断言的契约:通道常量(拼错/改名会让注册表测试与桥接白名单一起红)。
 *
 * 结构契约不在这里做字面量自测 —— `DshVersionCheck` / `DshVersionProgressEvent`
 * 的必带字段与枚举全集由 `pnpm typecheck` 守护:它们只在生产方构造处被赋值,
 * 断言自己刚写的常量永远不会失败。消费端闭合见 renderer 的
 * `version-phases.test.ts`(reason/phase ↔ 映射 ↔ 文案键),事件形状见
 * `local-runtime.test.ts` 的升级编排用例(真实生产事件)。
 */
describe('dsh 版本管理契约', () => {
  it('check/upgrade/list 通道与进度事件名是唯一的既定值', () => {
    expect(DSH_VERSION_IPC.check).toBe('dsh-version:check')
    expect(DSH_VERSION_IPC.upgrade).toBe('dsh-version:upgrade')
    expect(DSH_VERSION_IPC.list).toBe('dsh-version:list')
    expect(DSH_VERSION_PROGRESS_EVENT).toBe('dsh:version-progress')
  })

  it('运行时确认的推送/回复/快照通道名是唯一的既定值', () => {
    expect(DSH_VERSION_IPC.confirmRequest).toBe('dsh-version:confirmRequest')
    expect(DSH_VERSION_IPC.confirmReply).toBe('dsh-version:confirmReply')
    expect(DSH_VERSION_IPC.confirmList).toBe('dsh-version:confirmList')
    const names = Object.values(DSH_VERSION_IPC)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('工作区快捷键契约', () => {
  it('白名单转发事件名是唯一的既定值', () => {
    expect(WORKSPACE_HOTKEY_EVENT).toBe('dsh:workspace-hotkey')
  })
})
