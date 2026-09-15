/**
 * 界面文案目录（T11,R6「完整 zh/en 双语」）—— 纯数据,不 import electron/React。
 *
 * 为什么用**扁平的 key → {zh,en}** 而不是两棵语言树:
 * 1. 漏译是编译期错误:两个语言写在同一处,少一个字段 `tsc` 直接报错
 *    (两棵树方案只能靠测试或人工比对发现漏译);
 * 2. 键是字面量联合类型,`t()` 的入参受检,拼错 key 编译不过;
 * 3. 便于「按视图前缀」分组检索(main.* / wizard.* / detail.* ...)。
 *
 * 约定:文案里不带尾部标点差异;插值统一用 `{name}` 占位符。
 */
export interface Message {
  zh: string
  en: string
}

export const MESSAGES = {
  // —— 应用外壳 / 通用 ——
  'app.name': { zh: 'DSH Hub', en: 'DSH Hub' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.confirm': { zh: '确认', en: 'Confirm' },
  'common.save': { zh: '保存', en: 'Save' },
  'common.delete': { zh: '删除', en: 'Delete' },
  'common.close': { zh: '关闭', en: 'Close' },
  'common.back': { zh: '返回', en: 'Back' },
  'common.next': { zh: '下一步', en: 'Next' },
  'common.retry': { zh: '重试', en: 'Retry' },
  'common.copy': { zh: '复制', en: 'Copy' },
  'common.copied': { zh: '已复制', en: 'Copied' },
  'common.loading': { zh: '加载中…', en: 'Loading…' },
  'common.backToOverview': { zh: '回到总览', en: 'Back to overview' },
  'common.unknown': { zh: '未知', en: 'Unknown' },

  // —— 侧栏 / 导航 ——
  'nav.overview': { zh: '总览', en: 'Overview' },
  'nav.backToWorkbench': { zh: '回到实例工作台', en: 'Back to the workbench' },
  'nav.workbench': { zh: '实例工作台', en: 'Instance workbench' },
  'nav.brandTagline': { zh: '实例管理', en: 'Instance manager' },
  'nav.searchPlaceholder': { zh: '搜索实例或地址', en: 'Search instances or addresses' },
  'nav.searchLabel': { zh: '搜索实例', en: 'Search instances' },
  'nav.groupBy': { zh: '列表分组方式', en: 'Group list by' },
  'nav.instanceList': { zh: '实例列表', en: 'Instance list' },
  'nav.toDark': { zh: '切换到深色外观', en: 'Switch to dark appearance' },
  'nav.toLight': { zh: '切换到浅色外观', en: 'Switch to light appearance' },
  'nav.groupMixed': { zh: '混排', en: 'Flat' },
  'nav.groupByType': { zh: '按类型分组', en: 'By transport' },
  'nav.settings': { zh: '设置', en: 'Settings' },
  'nav.newInstance': { zh: '新建实例', en: 'New instance' },
  'nav.expandSidebar': { zh: '展开侧边栏', en: 'Expand sidebar' },
  'nav.collapseSidebar': { zh: '收起侧边栏', en: 'Collapse sidebar' },
  'nav.instanceCount': { zh: '{n} 个实例', en: '{n} instances' },

  // —— 空态 ——
  'empty.title': { zh: '还没有实例', en: 'No instances yet' },
  'empty.body': {
    zh: '添加一个本机实例开始用，或者通过 SSH / 网址连接服务器上已经在跑的 dsh。',
    en: 'Add a local instance to get started, or connect to a dsh already running on a server via SSH or URL.'
  },
  'empty.newFirst': { zh: '新建第一个实例', en: 'Create your first instance' },
  'empty.shortcut': { zh: '快捷键 ⌘N', en: 'Shortcut ⌘N' },

  // —— 运行时状态 ——
  'status.stopped': { zh: '已停止', en: 'Stopped' },
  'status.starting': { zh: '启动中', en: 'Starting' },
  'status.running': { zh: '运行中', en: 'Running' },
  'status.error': { zh: '错误', en: 'Error' },

  // —— 传输类型 ——
  'transport.local': { zh: '本地', en: 'Local' },
  'transport.ssh': { zh: 'SSH', en: 'SSH' },
  'transport.http': { zh: '远程', en: 'Remote' },

  // —— 设计稿七态(展示层状态;与运行时四态的映射见 lib/format.ts)——
  'state.idle': { zh: '未连接', en: 'Not connected' },
  'state.connecting': { zh: '连接中', en: 'Connecting' },
  'state.auth': { zh: '需要登录', en: 'Sign-in required' },
  'state.connected': { zh: '已连接', en: 'Connected' },
  'state.interrupted': { zh: '重连中', en: 'Reconnecting' },
  'state.error': { zh: '连接错误', en: 'Connection error' },
  'state.locked': { zh: '已锁定', en: 'Locked' },

  // —— 详情页 ——
  'detail.login': { zh: '登录 / 重新登录', en: 'Sign in / Re-authenticate' },
  'detail.address': { zh: '地址', en: 'Address' },
  'detail.transport': { zh: '连接方式', en: 'Transport' },
  'detail.uptime': { zh: '运行时长', en: 'Uptime' },
  'detail.missing': { zh: '实例不存在或已被删除', en: 'This instance no longer exists' },
  'detail.deleteConfirm': { zh: '删除后不可恢复，确认删除？', en: 'This cannot be undone. Delete?' },

  // —— 认证面板 ——
  'auth.title': { zh: '需要登录', en: 'Sign in required' },
  'auth.titleOtp': { zh: '输入动态验证码', en: 'Enter verification code' },
  'auth.titleConnected': { zh: '已连接', en: 'Connected' },
  'auth.password': { zh: '密码', en: 'Password' },
  'auth.otp': { zh: '6 位动态验证码', en: '6-digit verification code' },
  'auth.backupCode': { zh: '备份码', en: 'Backup code' },
  'auth.useBackup': { zh: '改用备份码', en: 'Use a backup code' },
  'auth.useOtp': { zh: '改用动态验证码', en: 'Use a verification code' },
  'auth.submit': { zh: '登录', en: 'Sign in' },
  'auth.submitting': { zh: '提交中…', en: 'Submitting…' },
  'auth.locked': { zh: '失败次数过多，请等待 {seconds}s', en: 'Too many failures. Wait {seconds}s' },
  'auth.lockButton': { zh: '锁定 {seconds}s', en: 'Locked {seconds}s' },
  'auth.credentialsLocalOnly': {
    zh: '凭据仅用于本次登录；未勾选「记住」时不会存入保险库',
    en: 'Credentials are used for this sign-in only and are not stored in the vault unless you opt in'
  },
  'auth.onboarding': {
    zh: '该实例仍在使用初始密码，请先在实例页面内完成改密后再登录。',
    en: 'This instance still uses its initial password. Change it in the instance page first.'
  },
  'auth.passwordForOtp': {
    zh: '密码（验证码需与密码同一次提交）',
    en: 'Password (submitted together with the code)'
  },
  'auth.needReusedPassword': {
    zh: '需要复用本次登录的密码',
    en: 'The password from this sign-in attempt is required'
  },
  'auth.otpHint': {
    zh: '该实例启用了二因素认证，提交密码后会要求输入验证码。',
    en: 'Two-factor authentication is enabled; a code will be requested after your password.'
  },

  // —— 凭据存储（T10 §7.2）——
  'vault.title': { zh: '凭据存储', en: 'Credential storage' },
  'vault.backendKeychain': { zh: '系统钥匙串（safeStorage）', en: 'System keychain (safeStorage)' },
  'vault.backendMemory': {
    zh: '仅本次会话（系统钥匙串不可用）',
    en: 'This session only (system keychain unavailable)'
  },
  'vault.degraded': {
    zh: '系统钥匙串不可用：勾选不会生效，保险库中的凭据只在本次运行期间保留在内存中，重启后需要重新登录。',
    en: 'The system keychain is unavailable: the checkboxes have no effect and vault credentials are kept in memory only, so they will not survive a restart.'
  },
  'vault.rememberPassword': {
    zh: '记住密码（写入系统钥匙串；取消勾选会立即删除已存密码）',
    en: 'Remember password (stored in the system keychain; unchecking deletes it immediately)'
  },
  'vault.rememberSession': {
    zh: '记住登录态（重启后静默复用会话；取消勾选会立即删除已存会话）',
    en: 'Remember sign-in (reuse the session after a restart; unchecking deletes it immediately)'
  },
  'vault.clear': { zh: '清除已记住的凭据', en: 'Clear remembered credentials' },
  'vault.remembered': { zh: '该实例已记住凭据', en: 'Credentials are remembered for this instance' },
  'vault.notRemembered': {
    zh: '该实例未记住任何凭据',
    en: 'No credentials are remembered for this instance'
  },
  'vault.otpNeverStored': {
    zh: '动态验证码（TOTP）密钥永不存储 —— 它只存在于你自己的认证器里。',
    en: 'TOTP secrets are never stored — they live only in your authenticator app.'
  },

  // —— 设置页 ——
  'settings.title': { zh: '设置', en: 'Settings' },
  'settings.language': { zh: '语言', en: 'Language' },
  'settings.languageHint': { zh: '切换后立即生效', en: 'Applies immediately' },
  'settings.theme': { zh: '主题', en: 'Theme' },
  'settings.themeSystem': { zh: '跟随系统', en: 'System' },
  'settings.themeLight': { zh: '浅色', en: 'Light' },
  'settings.themeDark': { zh: '深色', en: 'Dark' },
  'settings.tray': { zh: '关闭窗口时最小化到托盘', en: 'Minimize to tray when the window closes' },
  'settings.autoStart': { zh: '开机自启', en: 'Launch at login' },
  'settings.notifications': { zh: '实例状态通知', en: 'Instance status notifications' },
  'settings.dataDir': { zh: '数据目录', en: 'Data directory' },
  'settings.openDataDir': { zh: '打开数据目录', en: 'Open data directory' },
  'settings.clearCredentials': {
    zh: '清除所有已记住的凭据',
    en: 'Clear all remembered credentials'
  },
  'settings.saved': { zh: '设置已保存', en: 'Settings saved' },

  // —— 运行时长（T11:原先在 lib/format.ts 里拼中文）——
  'duration.seconds': { zh: '{n} 秒', en: '{n}s' },
  'duration.minutes': { zh: '{n} 分钟', en: '{n}m' },
  'duration.hours': { zh: '{h} 小时 {m} 分', en: '{h}h {m}m' },
  'duration.days': { zh: '{d} 天 {h} 小时', en: '{d}d {h}h' },
  'detail.notRunning': { zh: '未运行', en: 'Not running' },
  'detail.instanceDetail': { zh: '实例详情', en: 'Instance details' },

  // —— 托盘（T11）——
  'tray.show': { zh: '显示主窗口', en: 'Show window' },
  'tray.quit': { zh: '退出 DSH Hub', en: 'Quit DSH Hub' },
  'tray.status': { zh: '{count} 个实例运行中', en: '{count} running' }
} as const satisfies Record<string, Message>

export type MessageKey = keyof typeof MESSAGES

/** 从文案 key 推导的联合类型(供 UI 层与测试使用) */
export const MESSAGE_KEYS = Object.keys(MESSAGES) as MessageKey[]
