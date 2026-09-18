/**
 * 界面文案目录 —— 纯数据，不 import electron/React。
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
  'detail.login': { zh: '登录', en: 'Sign in' },
  'detail.openWorkspace': { zh: '打开工作区', en: 'Open workspace' },
  'detail.openingWorkspace': { zh: '正在打开工作区…', en: 'Opening workspace…' },
  'detail.runtime': { zh: '运行环境', en: 'Runtime' },
  'detail.relogin': { zh: '重新登录', en: 'Re-sign in' },
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
    zh: '密码和登录态默认安全保存在系统钥匙串；可在实例详情中取消记住。',
    en: 'Passwords and sessions are saved in the system keychain by default; you can opt out in instance details.'
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
  'auth.storedHint': {
    zh: '密码留空将使用保险库里已保存的密码登录',
    en: 'Leave the password empty to sign in with the saved password'
  },
  'auth.otpHint': {
    zh: '该实例启用了二因素认证，提交密码后会要求输入验证码。',
    en: 'Two-factor authentication is enabled; a code will be requested after your password.'
  },
  'auth.submitOtp': { zh: '提交', en: 'Submit' },
  'auth.otpRequiredHint': {
    zh: '此页仅在实例开启两因素验证后出现；未开启的实例输入密码即直接登录。',
    en: 'This step appears only when the instance has 2FA enabled; otherwise signing in with your password goes straight through.'
  },

  // —— 凭据存储 ——
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
    zh: '记住登录态：复用会话',
    en: 'Remember sign-in: reuse session'
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
  'settings.workspaceCache': { zh: '工作区缓存数量', en: 'Workspace cache size' },
  'settings.workspaceCacheHint': {
    zh: '保留最近使用的工作区；切换时可减少重新加载',
    en: 'Keeps recently used workspaces ready for faster switching'
  },
  'settings.dataDir': { zh: '数据目录', en: 'Data directory' },
  // 数据目录提供「打开」控件。
  'settings.openDataDir': { zh: '打开', en: 'Open' },
  'settings.openDataDirFailed': {
    zh: '打开数据目录失败',
    en: 'Failed to open the data directory'
  },
  'settings.clearCredentials': {
    zh: '清除所有已记住的凭据',
    en: 'Clear all remembered credentials'
  },
  'settings.saved': { zh: '设置已保存', en: 'Settings saved' },
  'settings.saveFailed': { zh: '设置保存失败', en: 'Failed to save settings' },
  'settings.cleared': { zh: '已清除所有记住的凭据', en: 'All remembered credentials cleared' },

  // —— 运行时长 ——
  'duration.seconds': { zh: '{n} 秒', en: '{n}s' },
  'duration.minutes': { zh: '{n} 分钟', en: '{n}m' },
  'duration.hours': { zh: '{h} 小时 {m} 分', en: '{h}h {m}m' },
  'duration.days': { zh: '{d} 天 {h} 小时', en: '{d}d {h}h' },
  'detail.notRunning': { zh: '未运行', en: 'Not running' },
  'detail.instanceDetail': { zh: '实例详情', en: 'Instance details' },

  // —— 新建向导 ——
  'wizard.stepTransport': { zh: '连接方式', en: 'Transport' },
  'wizard.stepConfig': { zh: '配置', en: 'Configure' },
  'wizard.stepConfirm': { zh: '确认', en: 'Confirm' },
  'wizard.errName': { zh: '请填写实例名称', en: 'Enter an instance name' },
  'wizard.errHost': { zh: '请填写主机或 SSH 别名', en: 'Enter a host or SSH alias' },
  'wizard.errUsername': { zh: '请填写 SSH 用户名', en: 'Enter an SSH username' },
  'wizard.created': { zh: '「{name}」已创建', en: 'Created "{name}"' },
  'wizard.startFailed': { zh: '启动失败', en: 'Failed to start' },
  'wizard.title': { zh: '新建实例', en: 'New instance' },
  'wizard.sub': { zh: '三步创建一个可连接的 dsh 实例', en: 'Create a connectable dsh instance in three steps' },
  'wizard.nextShortcut': { zh: '⌘D 下一步', en: '⌘D Next' },
  'wizard.creating': { zh: '创建中…', en: 'Creating…' },
  'wizard.create': { zh: '创建', en: 'Create' },
  'wizard.nameLabel': { zh: '实例名称', en: 'Instance name' },
  'wizard.namePlaceholder': { zh: '例如：开发 · 日常', en: 'e.g. Development · Daily' },
  'wizard.nameHint': { zh: '只在本机使用，便于在侧边栏区分不同环境。', en: 'Local only; helps tell environments apart in the sidebar.' },
  'wizard.advanced': { zh: '高级设置（启动器 / 版本 / 端口）', en: 'Advanced (launcher / version / port)' },
  'wizard.versionLabel': { zh: 'dsh 版本', en: 'dsh version' },
  'wizard.versionPlaceholder': { zh: '留空 = 自动选择最新稳定版', en: 'Blank = latest stable' },
  'wizard.localDetected': { zh: '检测到本机 dsh {version}', en: 'Local dsh {version} detected' },
  'wizard.localDetectedPath': { zh: '将直接复用本机安装，无需填写版本。', en: 'The local installation will be reused; no version is required.' },
  'wizard.externalDetected': { zh: '检测到正在运行的 dsh web（127.0.0.1:{port}）', en: 'A running dsh web was detected (127.0.0.1:{port})' },
  'wizard.currentWorkspace': { zh: '当前工作区', en: 'Current workspace' },
  'wizard.externalPatch': { zh: '补丁：{patch}', en: 'Patch: {patch}' },
  'wizard.externalNoPatch': { zh: '未使用 patch', en: 'No patch in use' },
  'wizard.connectExistingNote': { zh: '将直接连接当前工作区，不会安装、启动或结束本机 dsh。', en: 'This connects directly to the current workspace; it will not install, start, or stop local dsh.' },
  'wizard.createNewNote': { zh: '将使用本机 dsh 创建新的隔离实例。', en: 'This creates a new isolated instance using local dsh.' },
  'wizard.useExistingExternal': { zh: '连接当前运行的工作区', en: 'Connect to the running workspace' },
  'wizard.externalAccessLabel': { zh: '访问 token 或完整链接', en: 'Access token or full URL' },
  'wizard.externalAccessHint': { zh: '粘贴 dsh web 输出的完整 URL，或仅粘贴其中的 token。验证成功后会加密保存在本机，dsh 重启并更换 token 后可在实例详情中更新。', en: 'Paste the full URL printed by dsh web, or just its token. After verification it is encrypted on this machine; update it in the instance details if dsh restarts with a new token.' },
  'wizard.errExternalAccess': { zh: '请填写当前工作区的访问 token 或完整链接', en: 'Enter the current workspace access token or full URL' },
  'wizard.createNewLocal': { zh: '创建新的本机实例', en: 'Create a new local instance' },
  'wizard.portLabel': { zh: '端口', en: 'Port' },
  'wizard.portPlaceholder': { zh: '留空 = 自动分配（30000+）', en: 'Blank = auto-assign (30000+)' },
  'wizard.profileLabel': { zh: 'Profile', en: 'Profile' },
  'wizard.profilePlaceholder': { zh: '留空 = web', en: 'Blank = web' },
  'wizard.spaceLabel': { zh: '运行空间', en: 'Runtime space' },
  'wizard.spaceIsolated': { zh: '隔离实例', en: 'Isolated instance' },
  'wizard.spaceShared': { zh: '公共空间：~/.dsh', en: 'Shared space: ~/.dsh' },
  'wizard.spaceHint': { zh: '公共空间复用现有 dsh 的配置、插件与会话；同一时间请只运行一个实例。', en: 'The shared space reuses existing dsh config, plugins, and sessions; run only one instance at a time.' },
  'wizard.errProfile': { zh: 'Profile 不能包含 ..', en: 'Profile cannot contain ..' },
  'wizard.launcherLabel': { zh: '启动器', en: 'Launcher' },
  'wizard.launcherMissing': { zh: '未检测到，将自动下载 dsh', en: 'Not detected; dsh will be downloaded automatically' },
  'wizard.launcherMissingHint': { zh: '未检测到 dsh 或 dush；创建后启动时将提示下载 dsh。', en: 'Neither dsh nor dush was detected; starting after creation will prompt to download dsh.' },
  'wizard.hostLabel': { zh: '主机（或 ~/.ssh/config 别名）', en: 'Host (or ~/.ssh/config alias)' },
  'wizard.hostPlaceholder': { zh: 'build-01.internal 或 build-01', en: 'build-01.internal or build-01' },
  'wizard.userLabel': { zh: '用户名', en: 'Username' },
  'wizard.sshPortLabel': { zh: 'SSH 端口', en: 'SSH port' },
  'wizard.remotePortLabel': { zh: '远端 dsh 端口', en: 'Remote dsh port' },
  'wizard.urlLabel': { zh: '实例网址', en: 'Instance URL' },
  'wizard.urlHint': { zh: '粘贴完整 URL 会自动解析，不支持内嵌凭据。', en: 'Pasting a full URL parses it automatically; embedded credentials are not supported.' },
  'wizard.confirmHint': { zh: '最后确认一遍，名称与地址之后仍可在实例详情里修改。', en: 'One last check — the name and address can still be changed in the instance details.' },
  'wizard.dtName': { zh: '名称', en: 'Name' },
  'wizard.dtTransport': { zh: '连接方式', en: 'Transport' },
  'wizard.dtAddress': { zh: '地址', en: 'Address' },
  'wizard.autoPort': { zh: '127.0.0.1（自动分配端口）', en: '127.0.0.1 (port auto-assigned)' },
  'wizard.noteLocal': { zh: '本机实例创建完成后会自动安装 dsh 并启动，就绪后直接打开工作区。', en: 'A local instance installs dsh and starts automatically, then opens the workspace.' },
  'wizard.noteSsh': { zh: '首次连接需要核对服务器指纹，确认后才会建立加密通道。', en: 'The first connection verifies the server fingerprint before the encrypted channel is established.' },
  'wizard.noteHttp': { zh: '粘贴网址后已在第二步实时探测登录方式。', en: 'The sign-in mode was probed live in step two.' },
  // 保存前显示直连 HTTP 实例的数据面明文警告。
  'wizard.cleartextWarning': {
    zh: '该地址是 http://，数据面为明文：密码、动态验证码与会话 Cookie 都会以明文经过网络。http 实例完全可用；若希望数据面也被加密，https 端点或 SSH 隧道更稳妥。',
    en: 'This address uses http://, so the data plane is cleartext: the password, verification code and session cookie travel over the network unencrypted. http instances work fine; an https endpoint or an SSH tunnel is simply more private if you want the data plane encrypted too.'
  },
  'wizard.typeLocal': { zh: '本机运行的 dsh', en: 'dsh running locally' },
  'wizard.typeLocalDesc': { zh: '版本按需安装，互不干扰', en: 'Versions installed on demand, isolated' },
  'wizard.typeSsh': { zh: '经 SSH 隧道连接', en: 'Over an SSH tunnel' },
  'wizard.typeSshDesc': { zh: '复用系统密钥与 ssh-agent', en: 'Reuses system keys and ssh-agent' },
  'wizard.typeHttp': { zh: '直连远程网址', en: 'Direct remote URL' },
  'wizard.typeHttpDesc': { zh: 'dsh 网关登录统一管理', en: 'Sign-in managed through the dsh gateway' },
  'wizard.prev': { zh: '上一步', en: 'Back' },
  'wizard.next': { zh: '下一步', en: 'Next' },
  'wizard.sshAgentHint': {
    zh: '复用系统 ssh-agent 与 ~/.ssh/config；密钥内容绝不展示、也不会写入应用存储。',
    en: 'Reuses the system ssh-agent and ~/.ssh/config; key contents are never displayed or stored by the app.'
  },

  // —— 实例详情 ——
  'detail.loggedOut': { zh: '已登出', en: 'Signed out' },
  'detail.loggedOutDetail': { zh: '该实例的分区会话已清除', en: 'The instance partition session was cleared' },
  'detail.addressCopied': { zh: '地址已复制', en: 'Address copied' },
  'detail.copyFailed': { zh: '复制失败', en: 'Copy failed' },
  'detail.deleteFailed': { zh: '删除失败', en: 'Delete failed' },
  'detail.openViewFailed': { zh: '打开视图失败', en: 'Failed to open the view' },
  'detail.startWorkspace': { zh: '启动并打开工作区', en: 'Start and open workspace' },
  'detail.startFailed': { zh: '启动失败', en: 'Failed to start' },
  'detail.overview': { zh: '总览', en: 'Overview' },
  'detail.connection': { zh: '连接方式', en: 'Transport' },
  'detail.loopback': { zh: '本机回环', en: 'local loopback' },
  'detail.tunnelEncrypted': { zh: '加密隧道', en: 'encrypted tunnel' },
  'detail.direct': { zh: '直连', en: 'direct' },
  'detail.sshPort': { zh: 'SSH 端口', en: 'SSH port' },
  'detail.remotePort': { zh: '远端端口', en: 'Remote port' },
  'detail.tunnel': { zh: '隧道', en: 'Tunnel' },
  'detail.unassigned': { zh: '未分配', en: 'not assigned' },
  'detail.identityFile': { zh: '使用密钥', en: 'Key' },
  'detail.defaultAgentFirst': { zh: '默认（agent 优先）', en: 'default (ssh-agent first)' },
  'detail.authMode': { zh: '认证', en: 'Auth' },
  'detail.authNone': { zh: '无需登录', en: 'no sign-in required' },
  'detail.authGateway': { zh: '网关登录（密码 + 动态验证码）', en: 'gateway (password + TOTP)' },
  'detail.authAuto': { zh: '自动探测（连接后识别）', en: 'auto-detect on connect' },
  'detail.runInfo': { zh: '运行信息', en: 'Runtime' },
  'detail.localSide': { zh: '本机', en: 'local' },
  'detail.remoteSide': { zh: '远端', en: 'remote' },
  'detail.dshVersion': { zh: 'dsh 版本', en: 'dsh version' },
  'detail.port': { zh: '端口', en: 'Port' },
  'detail.dataDirTitle': { zh: '该实例隔离的 DSH_HOME', en: 'Isolated DSH_HOME for this instance' },
  'detail.stop': { zh: '停止', en: 'Stop' },
  'detail.starting': { zh: '启动中…', en: 'Starting…' },
  'detail.start': { zh: '启动', en: 'Start' },
  'detail.openView': { zh: '打开视图', en: 'Open view' },
  'detail.noRuntimeControl': { zh: '该传输类型暂不支持运行时控制', en: 'Runtime control is not supported for this transport' },
  'detail.externalTitle': { zh: '本机已在运行的 dsh web', en: 'dsh web already running on this machine' },
  'detail.externalCount': { zh: '检测到 {n} 个', en: '{n} detected' },
  'detail.externalBody': {
    zh: '这是你自己启动的 dsh 进程（hub 不会结束它）。接管后可直接打开视图，无需 hub 再启动一个。',
    en: 'These are dsh processes you started yourself (hub never terminates them). Adopt one to open its view directly instead of starting another.'
  },
  'detail.externalPatch': { zh: '补丁', en: 'patch' },
  'detail.externalNoPatch': { zh: '未使用 patch', en: 'no patch' },
  'detail.adopt': { zh: '接管', en: 'Adopt' },
  'detail.adopting': { zh: '接管中…', en: 'Adopting…' },
  'detail.adopted': { zh: '已接管外部 dsh web', en: 'Adopted external dsh web' },
  'detail.adoptFailed': { zh: '接管失败', en: 'Adopt failed' },
  'detail.externalTokenTitle': { zh: '本机 dsh 访问 token', en: 'Local dsh access token' },
  'detail.externalTokenBody': { zh: '其他进程重启 dsh 后，访问 token 可能变化。粘贴最新 token 或完整链接后重新连接。', en: 'The access token can change when another process restarts dsh. Paste the latest token or full URL, then reconnect.' },
  'detail.externalTokenUpdate': { zh: '更新 token 并连接', en: 'Update token and connect' },
  'detail.externalTokenUpdating': { zh: '正在更新…', en: 'Updating…' },
  'detail.externalDataDir': {
    zh: '（外部进程，由你自己管理）',
    en: '(external process, managed by you)'
  },
  'detail.dangerZone': { zh: '危险操作', en: 'Danger zone' },
  'detail.irreversible': { zh: '不可撤销', en: 'irreversible' },
  'detail.deleteInstance': { zh: '删除实例', en: 'Delete instance' },
  'detail.deleteTitle': { zh: '删除实例', en: 'Delete instance' },
  'detail.deleteCannotUndo': { zh: '此操作不可撤销', en: 'This cannot be undone' },
  'detail.missingHint': { zh: '实例不存在或已被删除。', en: 'This instance no longer exists.' },
  'detail.logout': { zh: '登出', en: 'Sign out' },
  'detail.deleted': { zh: '「{name}」已删除', en: 'Deleted "{name}"' },
  'detail.loopbackWarning': {
    zh: '本机回环连接未加密。仅本机可访问，不会经过网络；实例页面由 dsh 自带的浏览器令牌保护（browser-auth）。',
    en: 'The loopback connection is unencrypted. Only this machine can reach it and no traffic leaves the host; the instance page is protected by dsh\u2019s built-in browser token (browser-auth).'
  },
  // 直连 HTTP 实例持续显示数据面明文警告。
  'detail.cleartextWarning': {
    zh: '未加密连接：直连 http:// 端点的数据面为明文，密码、动态验证码与会话 Cookie 都会以明文经过网络。http 实例完全可用；若希望数据面也被加密，https 端点或 SSH 隧道更稳妥。',
    en: 'Unencrypted connection: a direct http:// endpoint has a cleartext data plane, so the password, verification code and session cookie travel over the network unencrypted. http instances work fine; an https endpoint or an SSH tunnel is simply more private if you want the data plane encrypted too.'
  },
  'detail.cleartextBadge': { zh: '未加密连接', en: 'Unencrypted' },
  // —— 实例编辑 ——
  'edit.openButton': { zh: '编辑', en: 'Edit' },
  'edit.title': { zh: '编辑实例', en: 'Edit instance' },
  'edit.sub': { zh: '{name}：连接方式创建后不可更改；其余字段随时可改。', en: '{name}: the transport cannot be changed after creation; other fields can be edited any time.' },
  'edit.nameLabel': { zh: '名称', en: 'Name' },
  'edit.nameRequired': { zh: '名称不能为空', en: 'Name is required' },
  'edit.notesLabel': { zh: '备注', en: 'Notes' },
  'edit.authModeLabel': { zh: '认证方式', en: 'Authentication' },
  'edit.authModeAuto': { zh: '自动探测', en: 'Auto-detect' },
  'edit.authModeNone': { zh: '无需登录', en: 'No login' },
  'edit.authModeGateway': { zh: '网关登录', en: 'Gateway login' },
  'edit.authModeHint': { zh: '自动探测在连接时识别是否需要登录', en: 'Auto-detect probes the endpoint when connecting' },
  'edit.portLabel': { zh: '端口', en: 'Port' },
  'edit.portPlaceholder': { zh: '留空 = 自动分配', en: 'Empty = auto-assign' },
  'edit.launcherLabel': { zh: '启动器', en: 'Launcher' },
  'edit.launcherHint': { zh: 'Hub 固定使用 web、回环地址、端口和 --no-open；保存后下次启动生效。', en: 'Hub fixes web, the loopback host, port, and --no-open. Changes apply on the next start.' },
  'edit.profileLabel': { zh: 'Profile', en: 'Profile' },
  'edit.profilePlaceholder': { zh: '留空 = web', en: 'Empty = web' },
  'edit.profileInvalid': { zh: 'Profile 只能使用相对路径，且不能包含 .. 或以 - 开头', en: 'Profile must be a relative path without .. or a leading -' },
  'edit.autoStartLabel': { zh: '应用启动时自动拉起', en: 'Start automatically with the app' },
  'edit.hostLabel': { zh: '主机', en: 'Host' },
  'edit.usernameLabel': { zh: '用户名', en: 'Username' },
  'edit.remotePortLabel': { zh: '远端端口', en: 'Remote port' },
  'edit.identityLabel': { zh: '私钥路径', en: 'Identity file' },
  'edit.identityPlaceholder': { zh: '留空 = 默认（agent 优先）', en: 'Empty = default (agent first)' },
  'edit.sshRequired': { zh: '主机、用户名与远端端口不能为空', en: 'Host, username and remote port are required' },
  'edit.endpointLabel': { zh: '端点 URL', en: 'Endpoint URL' },
  'edit.endpointHint': { zh: '仅支持 http/https，禁止内嵌凭据', en: 'http/https only; inline credentials are rejected' },
  'edit.endpointRequired': { zh: '端点 URL 不能为空', en: 'Endpoint URL is required' },
  'edit.saved': { zh: '已保存', en: 'Saved' },
  'edit.failed': { zh: '保存失败', en: 'Failed to save' },
  'edit.restartHint': { zh: '实例运行中：端口与配置改动将在下次启动生效。', en: 'Instance is running: port and config changes take effect on next start.' },
  'detail.deleteBody': {
    zh: '删除后本地保存的登录信息与连接记录会一并移除，远端 dsh 本身不受影响。',
    en: 'Local sign-in data and connection history are removed too; the remote dsh itself is unaffected.'
  },
  'detail.delete': { zh: '删除', en: 'Delete' },

  // —— SSH 指纹/口令对话框 ——
  'ssh.hostKeyChangedTitle': { zh: '服务器指纹已变化', en: 'Server fingerprint changed' },
  'ssh.hostKeyTitle': { zh: '连接安全确认', en: 'Confirm connection security' },
  'ssh.hostKeyChangedSub': { zh: '与此前信任的不一致', en: 'differs from what was trusted before' },
  'ssh.hostKeyNewSub': { zh: '首次连接前需核对身份', en: 'verify the identity before first connecting' },
  'ssh.hostKeyChangedHint': {
    zh: '连接已被拒绝：本应用不会在连接时覆盖已信任的指纹。请先与服务管理员核对；确属服务器重新生成密钥时，用「忘记该主机指纹」重新确认。',
    en: 'Connection refused: this app never overwrites a trusted fingerprint during a connection. Verify with the server administrator first; if the server really was re-keyed, use "Forget this host key" to verify it again.'
  },
  'ssh.hostKeyNewHint': {
    zh: '确认后会写入本机私有 known_hosts',
    en: 'Confirming writes it to the app-private known_hosts'
  },
  'ssh.hostKeyMismatch': {
    zh: '这台服务器出示的指纹与已信任的不一致，连接已被拒绝。',
    en: 'The fingerprint this server presents differs from the trusted one. The connection was refused.'
  },
  'ssh.askpassTitle': { zh: '需要输入 SSH 口令', en: 'SSH passphrase required' },
  'ssh.askpassTransient': {
    zh: '口令只用于本次连接，不会写入磁盘或日志',
    en: 'The passphrase is used for this connection only and is never written to disk or logs'
  },
  'ssh.askpassLabel': { zh: '口令 / 私钥口令', en: 'Passphrase / key passphrase' },
  'ssh.trustAndConnect': { zh: '这是我的服务器，信任并连接', en: 'This is my server — trust and connect' },
  'ssh.changedWarning': {
    zh: '可能是服务器重装或密钥轮换，也可能是中间人攻击。为避免误信任，本应用不会在连接时覆盖已信任的指纹；确认服务器端确实换了密钥后，用「忘记该主机指纹」重新走首次确认。',
    en: 'This can be a reinstall or key rotation, but it can also be a man-in-the-middle attack. To avoid trusting the wrong key, this app never overwrites a trusted fingerprint during a connection; once you have confirmed the server really was re-keyed, use "Forget this host key" to verify it as a first-time host.'
  },
  // 显式删除已保存的指纹后，下一次连接会重新执行 TOFU 确认。
  'ssh.forgetHostKey': { zh: '忘记该主机指纹', en: 'Forget this host key' },
  'ssh.forgetTitle': { zh: '忘记该主机指纹', en: 'Forget this host key' },
  'ssh.forgetIrreversible': {
    zh: '不可撤销：只删本机记录，不影响服务器',
    en: 'Irreversible: it only clears the local record; the server is unaffected'
  },
  'ssh.forgetConfirm': { zh: '确认忘记', en: 'Forget it' },
  'ssh.forgetBody': {
    zh: '这会删除本机为此主机保存的已信任指纹。下次连接会重新按「首次连接」核对新指纹 —— 只有在你已确认新指纹确实来自该服务器时才应这样做。',
    en: 'This deletes the trusted fingerprint stored on this machine for that host. The next connection verifies the new fingerprint as a first-time host — do this only once you have confirmed that the new fingerprint really belongs to that server.'
  },
  'ssh.forgetDone': {
    zh: '已忘记该主机指纹，下次连接将重新核对',
    en: 'Host key forgotten; the next connection will verify it again'
  },
  'ssh.forgetFailed': { zh: '忘记主机指纹失败', en: 'Could not forget the host key' },
  'ssh.untrustedHint': {
    zh: '「{target}」还没有被信任过，请核对下面的指纹是否与服务端一致。',
    en: '"{target}" has not been trusted yet. Check that the fingerprint below matches the server.'
  },
  'ssh.previouslyTrusted': { zh: '此前信任：', en: 'Previously trusted: ' },
  'ssh.continue': { zh: '继续', en: 'Continue' },

  // —— 总览表格 ——
  'home.statInstances': { zh: '个实例，本地 / SSH / 远程统一入口', en: 'instances — one place for local, SSH and remote' },
  'home.statConnected': { zh: '个已连接，通道正常', en: 'connected with a healthy channel' },
  'home.statAttention': { zh: '个需要处理，登录或重试', en: 'need attention — sign in or retry' },
  'home.allInstances': { zh: '全部实例', en: 'All instances' },
  'home.liveStatus': { zh: '状态实时刷新', en: 'Status updates live' },
  'home.colInstance': { zh: '实例', en: 'Instance' },
  'home.colType': { zh: '类型', en: 'Type' },
  'home.colStatus': { zh: '状态', en: 'Status' },
  'home.colAddress': { zh: '地址', en: 'Address' },
  'home.colVersion': { zh: '版本', en: 'Version' },
  'home.colActions': { zh: '操作', en: 'Actions' },
  'home.loadingList': { zh: '正在加载实例列表', en: 'Loading instance list' },
  'home.heroTitle': { zh: '{n} 个实例已连接', en: '{n} instances connected' },
  'home.heroBody': {
    zh: '本机、SSH 与远程实例都在这里。连接后工作区会嵌在应用内，断线自动重连，远程实例的登录与动态验证码也不用再切浏览器。',
    en: 'Local, SSH and remote instances all live here. Once connected, the workspace is embedded in the app, reconnects automatically, and remote sign-in with TOTP no longer needs a browser.'
  },
  'home.viewDetail': { zh: '查看详情', en: 'View details' },

  // —— SSH 密钥预览 ——
  'keyPreview.failed': { zh: '密钥解析失败', en: 'Key resolution failed' },
  'keyPreview.hint': {
    zh: '填写主机后会自动展示将使用哪个密钥。',
    en: 'Fill in the host and the key to be used is shown automatically.'
  },
  'keyPreview.resolving': { zh: '正在解析将使用的密钥…', en: 'Resolving the key to use…' },
  'keyPreview.none': {
    zh: '未检测到可用密钥（agent {agent}，也没有解析到默认私钥）。请启动 ssh-agent 并加载密钥，或改用密码认证。',
    en: 'No usable key found (agent {agent}, and no default private key resolved). Start ssh-agent and load a key, or switch to password authentication.'
  },
  'keyPreview.agentUnavailable': { zh: '未运行', en: 'not running' },
  'keyPreview.agentEmpty': { zh: '为空', en: 'empty' },
  'keyPreview.using': { zh: '将使用密钥：', en: 'Using key: ' },
  'keyPreview.defaultKey': { zh: '默认私钥', en: 'default private key' },
  'keyPreview.alternates': { zh: '备用 {n} 把', en: '{n} more available' },
  'keyPreview.explicit': { zh: '实例已指定私钥', en: 'instance pins a private key' },

  // —— 网址探测 ——
  'detect.gateway': {
    zh: '已识别登录认证（密码 + 动态验证码），创建后打开登录面板',
    en: 'Login gateway detected (password + TOTP); the sign-in panel opens after creation'
  },
  'detect.none': { zh: '无需登录认证，可直接访问', en: 'No authentication required; reachable directly' },
  'detect.browserAuth': {
    zh: '检测到 dsh 内置浏览器认证，将在实例页面内自认证',
    en: "dsh's built-in browser auth detected; it self-authenticates inside the instance page"
  },
  'detect.unreachable': {
    zh: '端点当前不可达；仍可创建，连接时会自动重试',
    en: 'Endpoint is unreachable right now; you can still create it and it will retry on connect'
  },
  'detect.unknown': {
    zh: '未能识别认证模式；连接时再判定',
    en: 'Could not identify the auth mode; it will be determined on connect'
  },
  'detect.failed': { zh: '探测失败', en: 'Detection failed' },
  'detect.hint': {
    zh: '粘贴完整网址后自动识别是否需要登录。',
    en: 'Paste a full URL to detect whether sign-in is required.'
  },
  'detect.probing': { zh: '正在探测端点…', en: 'Probing the endpoint…' },

  // —— 托盘 ——
  'notify.connected': { zh: '已连接', en: 'Connected' },
  'notify.error': { zh: '出错', en: 'Error' },
  'tray.show': { zh: '显示主窗口', en: 'Show window' },
  'tray.quit': { zh: '退出 DSH Hub', en: 'Quit DSH Hub' },
  'tray.status': { zh: '{count} 个实例运行中', en: '{count} running' }
} as const satisfies Record<string, Message>

export type MessageKey = keyof typeof MESSAGES

/** 从文案 key 推导的联合类型(供 UI 层与测试使用) */
export const MESSAGE_KEYS = Object.keys(MESSAGES) as MessageKey[]
