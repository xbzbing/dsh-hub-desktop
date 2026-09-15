/** `gateway-fixture.mjs` 的类型声明(契约测试用) */
export interface GatewayFixture {
  /** 归一化后的 baseUrl(含 basePath,无尾斜杠) */
  baseUrl: string
  password: string
  /** 临时 DSH_HOME(测试态) */
  home: string
  /** 当前有效 TOTP 验证码(仅 OTP 启用时有值) */
  otpCode: () => string | null
  otpSecret: string | null
  stop(): Promise<void>
}

export interface GatewayFixtureOptions {
  password?: string
  otpRequired?: boolean
  otpEnabled?: boolean
  basePath?: string
  lockMinutes?: number
  maxLoginFailures?: number
  minPasswordLength?: number
  /** 真实网关源码目录(缺省 DSH_AUTH_GATEWAY_SRC 或本机路径) */
  gatewaySrc?: string
}

export function startGatewayFixture(options?: GatewayFixtureOptions): Promise<GatewayFixture>
