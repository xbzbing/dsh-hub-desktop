import type { LocalLauncher } from '@shared/local-launch'

/** 向导表单：三种传输的字段合并存放，未使用字段保持默认值。 */
export interface WizardForm {
  name: string
  version: string
  profile: string
  port: string
  launcher: LocalLauncher
  useDefaultSpace: boolean
  registry: string
  host: string
  username: string
  sshPort: string
  remotePort: string
  endpointUrl: string
  externalAccess: string
}

export const EMPTY_FORM: WizardForm = {
  name: '',
  version: '',
  profile: '',
  port: '',
  launcher: 'dsh',
  useDefaultSpace: false,
  registry: '',
  host: '',
  username: '',
  sshPort: '22',
  remotePort: '3080',
  endpointUrl: '',
  externalAccess: ''
}

/** 探测到的本机已运行 dsh web（可接管）。 */
export interface ExternalWorkspace {
  pid: number
  port: number
  patch: string | null
}

export type WizardTransport = 'local' | 'ssh' | 'http'
