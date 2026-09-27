import type { CreateInstanceInput } from '@shared/contracts'
import type { ExternalWorkspace, WizardForm, WizardTransport } from './types'

/**
 * 由向导表单构造创建实例的 IPC 入参（纯函数）。
 * 各传输只带非默认字段：省略即用主进程 schema 默认值。
 */
export function buildCreateInput(args: {
  transport: WizardTransport
  form: WizardForm
  name: string
  useExistingExternal: boolean
  externalWorkspace: ExternalWorkspace | null
  existingSpaceId: string | null
}): CreateInstanceInput {
  const { transport, form, name, useExistingExternal, externalWorkspace, existingSpaceId } = args
  if (transport === 'local') {
    return {
      transport: 'local',
      name,
      ...(useExistingExternal
        ? {
            useExistingExternal: true,
            externalPid: externalWorkspace?.pid,
            externalAccess: form.externalAccess.trim()
          }
        : {}),
      ...(form.version.trim() !== '' ? { dshVersion: form.version.trim() } : {}),
      ...(form.profile.trim() !== '' ? { profile: form.profile.trim() } : {}),
      ...(form.port.trim() !== '' ? { port: Number(form.port) } : {}),
      ...(form.launcher !== 'dsh' ? { launcher: form.launcher } : {}),
      ...(form.useDefaultSpace ? { useDefaultSpace: true } : {}),
      ...(existingSpaceId ? { existingSpaceId } : {})
    }
  }
  if (transport === 'ssh') {
    return {
      transport: 'ssh',
      name,
      host: form.host.trim(),
      username: form.username.trim(),
      ...(form.sshPort !== '22' ? { port: Number(form.sshPort) } : {}),
      ...(form.remotePort !== '3080' ? { remotePort: Number(form.remotePort) } : {})
    }
  }
  return { transport: 'http', name, endpointUrl: form.endpointUrl.trim() }
}
