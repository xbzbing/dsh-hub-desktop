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
  'common.save': { zh: '保存', en: 'Save' },
  'common.close': { zh: '关闭', en: 'Close' },
  'common.copy': { zh: '复制', en: 'Copy' },
  'common.copied': { zh: '已复制', en: 'Copied' },
  'common.loading': { zh: '加载中…', en: 'Loading…' },
  'common.backToOverview': { zh: '回到总览', en: 'Back to overview' },
  'common.unknown': { zh: '未知', en: 'Unknown' },
  // 说明图标的读屏名称；具体说明正文由气泡按上下文提供。
  'common.hint': { zh: '说明', en: 'Details' },
  /** 列表连接符：中文用顿号、英文用逗号加空格（避免在代码里硬编码中日韩标点）。 */
  'common.listSeparator': { zh: '、', en: ', ' },
  // 分句连接：toast 明细由多个短句拼成时使用。
  'common.clauseSeparator': { zh: '；', en: '; ' },

  // —— 侧栏 / 导航 ——
  'nav.overview': { zh: '总览', en: 'Overview' },
  'nav.backToWorkbench': { zh: '回到实例工作台', en: 'Back to the workbench' },
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

  // —— 应用菜单 / 页内查找 ——
  'menu.edit': { zh: '编辑', en: 'Edit' },
  'menu.find': { zh: '查找', en: 'Find' },
  'find.placeholder': { zh: '在页面中查找', en: 'Find in page' },
  'find.label': { zh: '页内查找', en: 'Find in page' },
  'find.previous': { zh: '上一个匹配', en: 'Previous match' },
  'find.next': { zh: '下一个匹配', en: 'Next match' },
  'find.close': { zh: '关闭查找', en: 'Close find' },
  'find.noResults': { zh: '无结果', en: 'No results' },

  // —— 空态 ——
  'empty.title': { zh: '还没有实例', en: 'No instances yet' },
  'empty.body': {
    zh: '添加一个本机实例开始用，或者通过 SSH / 网址连接服务器上已经在跑的 dsh。',
    en: 'Add a local instance to get started, or connect to a dsh already running on a server via SSH or URL.'
  },
  'empty.newFirst': { zh: '新建第一个实例', en: 'Create your first instance' },
  'empty.shortcut': { zh: '快捷键 ⌘N', en: 'Shortcut ⌘N' },

  // —— 运行时状态 ——

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
  'state.installing': { zh: '安装中', en: 'Installing' },

  // —— 详情页 ——
  'detail.login': { zh: '登录', en: 'Sign in' },
  'detail.openWorkspace': { zh: '打开工作区', en: 'Open workspace' },
  'detail.openingWorkspace': { zh: '正在打开工作区…', en: 'Opening workspace…' },
  'detail.runtime': { zh: '运行环境', en: 'Runtime' },
  'detail.relogin': { zh: '重新登录', en: 'Re-sign in' },
  'detail.address': { zh: '地址', en: 'Address' },
  'detail.deleteConfirm': {
    zh: '删除后不可恢复，确认删除？',
    en: 'This cannot be undone. Delete?'
  },

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
  'auth.locked': {
    zh: '失败次数过多，请等待 {seconds}s',
    en: 'Too many failures. Wait {seconds}s'
  },
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
  'auth.useStoredPassword': {
    zh: '使用已保存的密码登录',
    en: 'Sign in with the saved password'
  },
  'auth.useStoredHint': {
    zh: '密码由主进程从系统钥匙串读取，不会显示在界面上。',
    en: 'The password is read from the system keychain by the main process and is never shown here.'
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
  'vault.remembered': {
    zh: '该实例已记住凭据',
    en: 'Credentials are remembered for this instance'
  },
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
  'settings.languageHint': { zh: '跟随系统或手动选择', en: 'Follow the system or choose manually' },
  'settings.languageSystem': { zh: '跟随系统', en: 'System' },
  'settings.languageChinese': { zh: '中文', en: 'Chinese' },
  'settings.languageEnglish': { zh: '英文', en: 'English' },
  'settings.theme': { zh: '主题', en: 'Theme' },
  'settings.themeSystem': { zh: '跟随系统', en: 'System' },
  'settings.themeLight': { zh: '浅色', en: 'Light' },
  'settings.themeDark': { zh: '深色', en: 'Dark' },
  // 通用设置卡的分组标题：偏好开关与环境/缓存设置分列其下。
  'settings.general': { zh: '通用偏好', en: 'Preferences' },
  'settings.tray': { zh: '关闭窗口时最小化到托盘', en: 'Minimize to tray when the window closes' },
  'settings.autoStart': { zh: '开机自启', en: 'Launch at login' },
  'settings.notifications': { zh: '实例状态通知', en: 'Instance status notifications' },
  'settings.preventSleepWhenRunning': {
    zh: '有本机实例运行时阻止系统休眠',
    en: 'Prevent system sleep while a local instance is running'
  },
  'settings.preventSleepWhenRunningHint': {
    zh: '本机实例运行期间阻止系统空闲休眠，长任务不被打断；合上笔记本盖子仍会休眠，也不影响熄屏/锁屏',
    en: 'Keeps the system awake while a local instance runs so long tasks are not interrupted; closing the laptop lid still sleeps, and the display can still turn off'
  },
  'settings.workspaceCache': { zh: '工作区缓存数量', en: 'Workspace cache size' },
  'settings.workspaceCacheHint': {
    zh: '保留最近使用的工作区；切换时可减少重新加载',
    en: 'Keeps recently used workspaces ready for faster switching'
  },
  'settings.inheritShellEnv': { zh: '继承登录 shell 环境', en: 'Inherit login shell environment' },
  'settings.inheritShellEnvHint': {
    zh: '本机实例继承登录 shell（含 .zshrc/.bashrc）的环境变量，与终端一致；关闭时仅继承 PATH',
    en: 'Local instances inherit environment variables from your login shell (including .zshrc/.bashrc), matching your terminal; when off, only PATH is inherited'
  },
  'settings.refreshEnv': { zh: '重新检测环境变量', en: 'Re-detect environment' },
  'settings.refreshEnvHint': {
    zh: '装了新工具（如 git/node）后点此刷新环境缓存，会列出 PATH 与环境变量的增删；重启实例即可生效，无需重启应用',
    en: 'After installing new tools (e.g. git/node), refresh the environment cache here to see PATH and variable changes; restart instances to apply, no app restart needed'
  },
  // 按钮文案：动作是「刷新缓存」；有无新工具由刷新后的 diff 报告，不在此判断。
  'settings.refreshEnvAction': { zh: '刷新环境缓存', en: 'Refresh cache' },
  // 刷新结果 toast：有变化列明细（PATH 条目与变量名），无变化/不可比各自成句。
  'settings.refreshEnvChangedTitle': {
    zh: '环境已刷新，发现变化',
    en: 'Environment refreshed: changes found'
  },
  'settings.refreshEnvNoChange': {
    zh: '环境已刷新，无变化',
    en: 'Environment refreshed; no changes'
  },
  'settings.refreshEnvIncomparable': {
    zh: '环境已刷新，环境不可解析，无法对比',
    en: 'Environment refreshed; environment unresolvable, nothing to compare'
  },
  'settings.refreshEnvDiffPathAdded': { zh: 'PATH 新增 {list}', en: 'PATH added: {list}' },
  'settings.refreshEnvDiffPathRemoved': { zh: 'PATH 删除 {list}', en: 'PATH removed: {list}' },
  'settings.refreshEnvDiffVars': {
    zh: '环境变量：新增 {added}、删除 {removed}、变更 {changed}',
    en: 'Variables: {added} added, {removed} removed, {changed} changed'
  },
  'settings.refreshEnvFailed': {
    zh: '刷新环境缓存失败',
    en: 'Failed to refresh environment cache'
  },
  'settings.refreshEnvRestartTitle': {
    zh: '重启实例以应用新环境',
    en: 'Restart instances to apply'
  },
  'settings.refreshEnvRestartBody': {
    zh: '已刷新环境缓存。检测到 {count} 个正在运行的本机实例，是否立即重启以应用新环境？重启会短暂中断正在使用的工作区。',
    en: 'Environment cache refreshed. {count} local instance(s) are running. Restart them now to apply the new environment? Restarting briefly interrupts the workspaces in use.'
  },
  'settings.refreshEnvRestartConfirm': { zh: '立即重启', en: 'Restart now' },
  'settings.refreshEnvRestartLater': { zh: '稍后手动', en: 'Later' },
  'settings.refreshEnvRestarted': {
    zh: '已重启 {count} 个实例以应用新环境',
    en: 'Restarted {count} instance(s) to apply the new environment'
  },
  'settings.refreshEnvRestartFailed': {
    zh: '重启部分实例失败',
    en: 'Failed to restart some instances'
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
  // —— 检查更新（应用自身版本，读 GitHub Release）——
  'settings.checkUpdate': { zh: '检查更新', en: 'Check for updates' },
  'settings.checkingUpdate': { zh: '检查中…', en: 'Checking…' },
  'settings.updateCheckFailed': { zh: '检查更新失败', en: 'Failed to check for updates' },
  'settings.updateUpToDate': {
    zh: '已是最新版本（当前 v{version}）',
    en: 'You are up to date (v{version})'
  },
  'settings.updateAvailable': {
    zh: '发现新版本 v{latest}（当前 v{current}）',
    en: 'New version v{latest} available (you have v{current})'
  },
  'settings.updateOpenRelease': { zh: '查看发布页', en: 'View release' },
  'settings.updateOpenReleaseFailed': {
    zh: '打开发布页失败',
    en: 'Failed to open the release page'
  },
  'spaces.title': { zh: '空间管理', en: 'Space management' },
  'spaces.summary': {
    zh: '已有空间 {count} 个 · 占用 {size}',
    en: '{count} existing spaces · {size}'
  },
  'spaces.description': {
    zh: '管理 Hub 创建但尚未关联实例的隔离 DSH_HOME。',
    en: 'Manage isolated DSH_HOME directories created by Hub but not linked to an instance.'
  },
  'spaces.empty': { zh: '没有可管理的隔离空间', en: 'No isolated spaces to manage' },
  'spaces.createInstance': { zh: '以此空间创建实例', en: 'Create instance with this space' },
  'spaces.delete': { zh: '移入废纸篓', en: 'Move to Trash' },
  'spaces.trashTitle': { zh: '移入废纸篓', en: 'Move to Trash' },
  'spaces.trashConfirm': {
    zh: '确定将此空间移入系统废纸篓吗？可在废纸篓中恢复。',
    en: 'Move this space to the system Trash? You can restore it from there.'
  },
  'spaces.trashFailed': { zh: '移动空间失败', en: 'Failed to move space' },
  'spaces.trashed': { zh: '空间已移入废纸篓', en: 'Space moved to Trash' },
  'spaces.instanceDetail': { zh: '实例详情', en: 'Instance details' },
  'spaces.size': { zh: '占用 {size}', en: 'Size {size}' },
  'spaces.modifiedAt': { zh: '修改于 {time}', en: 'Modified {time}' },
  'spaces.columnIndex': { zh: '序号', en: '#' },
  'spaces.columnTitle': { zh: '标题', en: 'Title' },
  'spaces.columnSize': { zh: '占用', en: 'Size' },
  'spaces.columnModified': { zh: '最后修改', en: 'Last modified' },

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
  'wizard.sub': {
    zh: '三步创建一个可连接的 dsh 实例',
    en: 'Create a connectable dsh instance in three steps'
  },
  'wizard.nextShortcut': { zh: '⌘D 下一步', en: '⌘D Next' },
  'wizard.creating': { zh: '创建中…', en: 'Creating…' },
  'wizard.create': { zh: '创建', en: 'Create' },
  'wizard.nameLabel': { zh: '实例名称', en: 'Instance name' },
  'wizard.namePlaceholder': { zh: '例如：开发 · 日常', en: 'e.g. Development · Daily' },
  'wizard.nameHint': {
    zh: '只在本机使用，便于在侧边栏区分不同环境。',
    en: 'Local only; helps tell environments apart in the sidebar.'
  },
  'wizard.advanced': {
    zh: '高级设置（启动器 / 版本 / 端口）',
    en: 'Advanced (launcher / version / port)'
  },
  'wizard.versionLabel': { zh: 'dsh 版本', en: 'dsh version' },
  'wizard.versionLatest': { zh: '跟随最新版本', en: 'Follow latest' },
  'wizard.versionLoading': { zh: '正在获取版本列表…', en: 'Loading version list…' },
  'wizard.versionFetchFailed': {
    zh: '获取版本列表失败：{msg}',
    en: 'Failed to load version list: {msg}'
  },
  'wizard.versionHint': {
    zh: '版本列表来自当前镜像，仅显示最近 10 个（最新在前）；默认与本地版本相同，选择后将固定该版本。',
    en: 'From the current registry: the latest 10 versions (newest first); defaults to your local version, and a selection pins it.'
  },
  'wizard.externalDetected': {
    zh: '检测到正在运行的 dsh web（127.0.0.1:{port}）',
    en: 'A running dsh web was detected (127.0.0.1:{port})'
  },
  'wizard.externalDetectedMany': {
    zh: '检测到 {n} 个正在运行的 dsh web，请选择要接管的一个',
    en: '{n} running dsh web instances were detected; choose the one to adopt'
  },
  'wizard.externalPickLabel': {
    zh: '要接管的 dsh',
    en: 'dsh to adopt'
  },
  'wizard.currentWorkspace': { zh: '当前工作区', en: 'Current workspace' },
  'wizard.externalPatch': { zh: '补丁：{patch}', en: 'Patch: {patch}' },
  'wizard.externalNoPatch': { zh: '未使用 patch', en: 'No patch in use' },
  'wizard.connectExistingNote': {
    zh: '将直接连接当前工作区，不会安装、启动或结束本机 dsh。',
    en: 'This connects directly to the current workspace; it will not install, start, or stop local dsh.'
  },
  'wizard.createNewNote': {
    zh: '将使用本机 dsh 创建新的隔离实例。',
    en: 'This creates a new isolated instance using local dsh.'
  },
  'wizard.useExistingExternal': {
    zh: '连接当前运行的工作区',
    en: 'Connect to the running workspace'
  },
  'wizard.externalAccessLabel': { zh: '访问 token 或完整链接', en: 'Access token or full URL' },
  'wizard.externalAccessHint': {
    zh: '粘贴 dsh web 输出的完整 URL，或仅粘贴其中的 token。验证成功后会加密保存在本机，dsh 重启并更换 token 后可在实例详情中更新。',
    en: 'Paste the full URL printed by dsh web, or just its token. After verification it is encrypted on this machine; update it in the instance details if dsh restarts with a new token.'
  },
  'wizard.errExternalAccess': {
    zh: '请填写当前工作区的访问 token 或完整链接',
    en: 'Enter the current workspace access token or full URL'
  },
  'wizard.portLabel': { zh: '端口', en: 'Port' },
  'wizard.portPlaceholder': { zh: '留空 = 自动分配（30000+）', en: 'Blank = auto-assign (30000+)' },
  'wizard.profileLabel': { zh: 'Profile', en: 'Profile' },
  'wizard.profilePlaceholder': { zh: '留空 = web', en: 'Blank = web' },
  'wizard.spaceLabel': { zh: '运行空间', en: 'Runtime space' },
  'wizard.spaceIsolated': { zh: '隔离实例', en: 'Isolated instance' },
  'wizard.spaceShared': { zh: '公共空间：~/.dsh', en: 'Shared space: ~/.dsh' },
  'wizard.spaceSharedPath': { zh: '本机路径：{path}', en: 'Local path: {path}' },
  'wizard.spaceHint': {
    zh: '公共空间复用现有 dsh 的配置、插件与会话；同一时间请只运行一个实例。',
    en: 'The shared space reuses existing dsh config, plugins, and sessions; run only one instance at a time.'
  },
  'wizard.errProfile': { zh: 'Profile 不能包含 ..', en: 'Profile cannot contain ..' },
  'wizard.launcherLabel': { zh: '启动器', en: 'Launcher' },
  'wizard.launcherMissing': {
    zh: '未检测到，将自动下载 dsh',
    en: 'Not detected; dsh will be downloaded automatically'
  },
  'wizard.launcherMissingHint': {
    zh: '未检测到 dsh、dush 或 duush；创建后启动时将提示下载 dsh。',
    en: 'None of dsh, dush, duush was detected; starting after creation will prompt to download dsh.'
  },
  'wizard.hostLabel': { zh: '主机（或 ~/.ssh/config 别名）', en: 'Host (or ~/.ssh/config alias)' },
  'wizard.hostPlaceholder': {
    zh: 'build-01.internal 或 build-01',
    en: 'build-01.internal or build-01'
  },
  'wizard.userLabel': { zh: '用户名', en: 'Username' },
  'wizard.userPlaceholder': { zh: 'dev', en: 'dev' },
  'wizard.sshPortLabel': { zh: 'SSH 端口', en: 'SSH port' },
  'wizard.remotePortLabel': { zh: '远端 dsh 端口', en: 'Remote dsh port' },
  'wizard.urlLabel': { zh: '实例网址', en: 'Instance URL' },
  'wizard.urlHint': {
    zh: '粘贴完整 URL 会自动解析，不支持内嵌凭据。',
    en: 'Pasting a full URL parses it automatically; embedded credentials are not supported.'
  },
  'wizard.confirmHint': {
    zh: '最后确认一遍，名称与地址之后仍可在实例详情里修改。',
    en: 'One last check — the name and address can still be changed in the instance details.'
  },
  'wizard.dtName': { zh: '名称', en: 'Name' },
  'wizard.dtTransport': { zh: '连接方式', en: 'Transport' },
  'wizard.dtAddress': { zh: '地址', en: 'Address' },
  'wizard.autoPort': { zh: '127.0.0.1（自动分配端口）', en: '127.0.0.1 (port auto-assigned)' },
  'wizard.noteLocal': {
    zh: '本机实例创建完成后会自动安装 dsh 并启动，就绪后直接打开工作区。',
    en: 'A local instance installs dsh and starts automatically, then opens the workspace.'
  },
  'wizard.noteSsh': {
    zh: '首次连接需要核对服务器指纹，确认后才会建立加密通道。',
    en: 'The first connection verifies the server fingerprint before the encrypted channel is established.'
  },
  'wizard.noteHttp': {
    zh: '粘贴网址后已在第二步实时探测登录方式。',
    en: 'The sign-in mode was probed live in step two.'
  },
  // 保存前显示直连 HTTP 实例的数据面明文警告。
  'wizard.cleartextWarning': {
    zh: '该地址是 http://，数据面为明文：密码、动态验证码与会话 Cookie 都会以明文经过网络。http 实例完全可用；若希望数据面也被加密，https 端点或 SSH 隧道更稳妥。',
    en: 'This address uses http://, so the data plane is cleartext: the password, verification code and session cookie travel over the network unencrypted. http instances work fine; an https endpoint or an SSH tunnel is simply more private if you want the data plane encrypted too.'
  },
  'wizard.proxyLabel': { zh: '代理', en: 'Proxy' },
  'wizard.proxyTypeLabel': { zh: '代理类型', en: 'Proxy type' },
  'wizard.proxyNone': { zh: '不使用代理', en: 'No proxy' },
  'wizard.proxyHttp': { zh: 'HTTP 代理', en: 'HTTP proxy' },
  'wizard.proxySocks5': { zh: 'SOCKS5 代理', en: 'SOCKS5 proxy' },
  'wizard.proxyTypeHint': {
    zh: '需要经代理访问该端点时选择；HTTP 代理同时用于 http 与 https 目标。',
    en: 'Choose when the endpoint is reachable through a proxy; an HTTP proxy also handles https targets.'
  },
  'wizard.proxyHostLabel': { zh: '代理主机', en: 'Proxy host' },
  'wizard.proxyPortLabel': { zh: '代理端口', en: 'Proxy port' },
  'wizard.proxyUsernameLabel': { zh: '代理用户名（可选）', en: 'Proxy username (optional)' },
  'wizard.proxyPasswordLabel': { zh: '代理密码（可选）', en: 'Proxy password (optional)' },
  'wizard.proxyHint': {
    zh: '需要认证的 HTTP 代理密码保存在系统凭据保险库，不会写入实例配置。',
    en: 'For an authenticated HTTP proxy, the password is stored in the system credential vault, not in the instance record.'
  },
  'wizard.proxySocksNoAuth': {
    zh: 'SOCKS5 代理不支持用户名/密码认证；代理服务器需允许无认证连接。',
    en: 'SOCKS5 proxies do not support username/password authentication; the proxy server must allow unauthenticated connections.'
  },
  'wizard.proxyDetectHint': {
    zh: '已启用代理：登录方式将在实例启动后通过代理探测。',
    en: 'Proxy enabled: the sign-in mode will be probed through it after the instance starts.'
  },
  'wizard.errProxyHost': { zh: '代理主机不能为空', en: 'Proxy host is required' },
  'wizard.errProxyPort': {
    zh: '代理端口必须在 1–65535 之间',
    en: 'Proxy port must be between 1 and 65535'
  },
  'wizard.errProxyPassword': {
    zh: '填写代理用户名时也需要填写代理密码',
    en: 'A proxy password is required when a proxy username is set'
  },
  'wizard.errProxySocksAuth': {
    zh: 'SOCKS5 代理不支持用户名/密码认证',
    en: 'SOCKS5 proxies do not support username/password authentication'
  },
  // 代理 schema 的验证文案是稳定 key，经 IPC 交给渲染层本地化，避免在 shared 层硬编码中文。
  'proxy.errPortNumber': { zh: '代理端口必须是数字', en: 'Proxy port must be a number' },
  'proxy.errPortInteger': { zh: '代理端口必须是整数', en: 'Proxy port must be an integer' },
  'proxy.errPortMin': { zh: '代理端口最小 1', en: 'Proxy port must be at least 1' },
  'proxy.errPortMax': { zh: '代理端口最大 65535', en: 'Proxy port must be at most 65535' },
  'proxy.errHostRequired': { zh: '代理主机不能为空', en: 'Proxy host is required' },
  'proxy.errHostTooLong': {
    zh: '代理主机最长 255 字符',
    en: 'Proxy host must be at most 255 characters'
  },
  'proxy.errHostFormat': {
    zh: '代理主机格式不合法（不允许空白、斜杠、@ 或端口）',
    en: 'Invalid proxy host (no whitespace, slashes, userinfo, or port)'
  },
  'proxy.errUsernameRequired': { zh: '代理用户名不能为空', en: 'Proxy username is required' },
  'proxy.errUsernameTooLong': {
    zh: '代理用户名最长 128 字符',
    en: 'Proxy username must be at most 128 characters'
  },
  'proxy.errPasswordEmpty': { zh: '代理密码不能为空', en: 'Proxy password is required' },
  'proxy.errPasswordTooLong': {
    zh: '代理密码最长 1024 字符',
    en: 'Proxy password must be at most 1024 characters'
  },
  'proxy.errSocksNoAuth': {
    zh: 'SOCKS5 代理不支持用户名/密码认证',
    en: 'SOCKS5 proxies do not support username/password authentication'
  },
  'proxy.errPasswordNeedsUsername': {
    zh: '设置代理密码时必须同时提供用户名',
    en: 'A proxy username is required when a proxy password is set'
  },
  'proxy.errPasswordMissing': {
    zh: '代理用户名需要同时设置密码',
    en: 'A proxy password is required when a proxy username is set'
  },
  'wizard.errProxyUsername': {
    zh: '填写代理密码时也需要填写代理用户名',
    en: 'A proxy username is required when a proxy password is set'
  },
  'wizard.typeLocal': { zh: '本机运行的 dsh', en: 'dsh running locally' },
  'wizard.typeLocalDesc': {
    zh: '版本按需安装，互不干扰',
    en: 'Versions installed on demand, isolated'
  },
  'wizard.typeSsh': { zh: '经 SSH 隧道连接', en: 'Over an SSH tunnel' },
  'wizard.typeSshDesc': { zh: '复用系统密钥与 ssh-agent', en: 'Reuses system keys and ssh-agent' },
  'wizard.typeHttp': { zh: '直连远程网址', en: 'Direct remote URL' },
  'wizard.typeHttpDesc': {
    zh: 'dsh 网关登录统一管理',
    en: 'Sign-in managed through the dsh gateway'
  },
  'wizard.prev': { zh: '上一步', en: 'Back' },
  'wizard.next': { zh: '下一步', en: 'Next' },
  'wizard.sshAgentHint': {
    zh: '复用系统 ssh-agent 与 ~/.ssh/config；密钥内容绝不展示、也不会写入应用存储。',
    en: 'Reuses the system ssh-agent and ~/.ssh/config; key contents are never displayed or stored by the app.'
  },
  'wizard.registryLabel': { zh: '安装镜像', en: 'Registry mirror' },
  'wizard.registryHint': {
    zh: 'dsh 下载与插件检查/安装的默认镜像；应用级设置，对所有实例生效。中国大陆推荐 npmmirror，海外推荐 npmjs。',
    en: 'Default npm mirror for dsh downloads and plugin check/install. App-wide setting applied to all instances. Use npmmirror in China, npmjs elsewhere.'
  },
  'wizard.registryNpmmirror': { zh: 'npmmirror（国内加速）', en: 'npmmirror (China)' },
  'wizard.registryNpmjs': { zh: 'npmjs（官方源）', en: 'npmjs (Global)' },
  'wizard.registryCustom': { zh: '自定义', en: 'Custom' },
  'wizard.registrySystem': { zh: '跟随系统 npm 配置', en: 'Follow system npm config' },

  // —— 实例详情 ——
  'detail.loggedOut': { zh: '已登出', en: 'Signed out' },
  'detail.loggedOutDetail': {
    zh: '该实例的分区会话已清除',
    en: 'The instance partition session was cleared'
  },
  'detail.addressCopied': { zh: '地址已复制', en: 'Address copied' },
  'detail.copyFailed': { zh: '复制失败', en: 'Copy failed' },
  'detail.deleteFailed': { zh: '删除失败', en: 'Delete failed' },
  'detail.openViewFailed': { zh: '打开视图失败', en: 'Failed to open the view' },
  'detail.openViewTimeout': {
    zh: '打开工作区超时，已返回详情页',
    en: 'Timed out opening the workspace; back to the detail view'
  },
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
  'detail.proxy': { zh: '代理', en: 'Proxy' },
  'detail.proxyNone': { zh: '直连（不使用代理）', en: 'Direct (no proxy)' },
  'detail.editProxy': { zh: '编辑代理', en: 'Edit proxy' },
  'detail.editProxySub': {
    zh: '{name}：保存后立即生效，已打开的工作区会刷新。',
    en: '{name}: applied immediately on save; an open workspace reloads.'
  },
  'detail.editProxyHint': {
    zh: '代理挂在实例自己的会话上：改动同时影响内嵌工作区与健康探测。',
    en: 'The proxy lives on the instance session: changes apply to the embedded workspace and health probes alike.'
  },
  'detail.proxySaved': { zh: '代理已保存', en: 'Proxy saved' },
  'detail.authNone': { zh: '无需登录', en: 'no sign-in required' },
  'detail.authGateway': { zh: '网关登录（密码 + 动态验证码）', en: 'gateway (password + TOTP)' },
  'detail.authAuto': { zh: '自动探测（连接后识别）', en: 'auto-detect on connect' },
  'detail.localSide': { zh: '本机', en: 'local' },
  'detail.remoteSide': { zh: '远端', en: 'remote' },
  'detail.dshVersion': { zh: 'dsh 版本', en: 'dsh version' },
  'detail.version.check': { zh: '检查更新', en: 'Check for updates' },
  'detail.version.checking': { zh: '检查中…', en: 'Checking…' },
  'detail.version.upToDate': { zh: '已是最新版本', en: 'Up to date' },
  'detail.version.found': {
    zh: '发现新版本 {latest}（当前 {current}）',
    en: 'New version {latest} available (current {current})'
  },
  'detail.version.upgrade': { zh: '升级', en: 'Upgrade' },
  'detail.version.retry': { zh: '重试', en: 'Retry' },
  'detail.version.checkFailed': { zh: '检查失败：{msg}', en: 'Check failed: {msg}' },
  'detail.version.upgradeFailed': { zh: '升级失败：{msg}', en: 'Upgrade failed: {msg}' },
  'detail.version.phase.checking': { zh: '检查中', en: 'Checking' },
  'detail.version.phase.downloading': { zh: '下载中', en: 'Downloading' },
  'detail.version.phase.installing': { zh: '安装中', en: 'Installing' },
  'detail.version.phase.done': { zh: '已完成', en: 'Done' },
  'detail.version.reason.notLocal': {
    zh: '仅本地实例支持版本管理',
    en: 'Only local instances support version management'
  },
  'detail.version.reason.runtimeExternal': {
    zh: '外部接管的 dsh 由你自行管理',
    en: 'Externally managed dsh is maintained by you'
  },
  'detail.version.reason.globalUnmanaged': {
    zh: '系统默认 dsh 缺失或非 npm 全局安装，hub 无法代管升级',
    en: 'The system default dsh is missing or not npm-managed; hub cannot upgrade it'
  },
  'detail.plugin.title': { zh: '插件管理', en: 'Plugins' },
  'detail.plugin.install': { zh: '安装插件', en: 'Install plugin' },
  'detail.plugin.refresh': { zh: '刷新', en: 'Refresh' },
  'detail.plugin.empty': {
    zh: '该实例暂无已安装插件',
    en: 'No plugins installed for this instance'
  },
  'detail.plugin.loadFailed': {
    zh: '加载插件列表失败：{msg}',
    en: 'Failed to load plugins: {msg}'
  },
  'detail.plugin.loading': { zh: '正在加载插件…', en: 'Loading plugins…' },
  'detail.plugin.checkUpdate': { zh: '检查升级', en: 'Check update' },
  'detail.plugin.checking': { zh: '检查中…', en: 'Checking…' },
  'detail.plugin.checkAll': { zh: '一键检查', en: 'Check all' },
  'detail.plugin.checkingAll': { zh: '检查中…', en: 'Checking…' },
  'detail.plugin.checkLocked': {
    zh: '一键检查进行中，完成后可单独检查',
    en: 'Check all is running; single checks unlock when it finishes'
  },
  'detail.plugin.lastChecked': { zh: '上次检查更新：{time}', en: 'Last checked: {time}' },
  'detail.plugin.upgradeTo': { zh: '升级到 {version}', en: 'Upgrade to {version}' },
  'detail.plugin.upgrading': { zh: '升级中…', en: 'Upgrading…' },
  'detail.plugin.uptodate': { zh: '已是最新版本', en: 'Up to date' },
  'detail.plugin.incompatible': {
    zh: '新版 {latest} 要求 dsh {peer}，当前 {current} 不满足',
    en: 'v{latest} requires dsh {peer}; current {current} does not satisfy it'
  },
  'detail.plugin.incompatibleUnknown': {
    zh: '新版 {latest} 要求 dsh {peer}，但当前 dsh 版本未知，无法判定兼容性',
    en: 'v{latest} requires dsh {peer}; current dsh version is unknown, compatibility cannot be determined'
  },
  'detail.plugin.checkFailed': { zh: '检查失败：{msg}', en: 'Check failed: {msg}' },
  'detail.plugin.remove': { zh: '卸载', en: 'Uninstall' },
  'detail.plugin.removing': { zh: '卸载中…', en: 'Uninstalling…' },
  'detail.plugin.autoDisabledTitle': {
    zh: '已自动禁用不兼容的插件',
    en: 'Incompatible plugins disabled'
  },
  'detail.plugin.autoDisabledBody': {
    zh: 'dsh {dshVersion} 与以下插件的声明不兼容，已禁用它们以免启动异常：{list}。升级插件后可在列表中重新启用。',
    en: 'dsh {dshVersion} is incompatible with these plugins, so they were disabled to avoid startup problems: {list}. Upgrade them, then re-enable them in the list.'
  },
  'detail.plugin.autoDisabledDismiss': { zh: '知道了', en: 'Got it' },
  'detail.plugin.log.autoDisabled': {
    zh: 'dsh {dshVersion} 不兼容，已自动禁用：{list}',
    en: 'Incompatible with dsh {dshVersion}; disabled: {list}'
  },
  'detail.plugin.disable': { zh: '禁用', en: 'Disable' },
  /** 开关的读屏/悬停说明：开=启用（已加载），关=禁用（已装但未加载）。 */
  'detail.plugin.enableToggle': { zh: '启用（已加载）', en: 'Enabled (loaded)' },
  'detail.plugin.enable': { zh: '启用', en: 'Enable' },
  'detail.plugin.disabled': { zh: '已禁用', en: 'Disabled' },
  'detail.plugin.enableFailed': { zh: '启用失败：{msg}', en: 'Failed to enable: {msg}' },
  'detail.plugin.disableFailed': { zh: '禁用失败：{msg}', en: 'Failed to disable: {msg}' },
  'detail.plugin.cannotDisable': {
    zh: '该插件随宿主 bundle 加载，无法单独禁用',
    en: 'This plugin loads with its host bundle and cannot be disabled individually'
  },
  'detail.plugin.removeFailed': { zh: '卸载失败：{msg}', en: 'Failed to uninstall: {msg}' },
  'detail.plugin.installFailed': { zh: '安装失败：{msg}', en: 'Failed to install: {msg}' },
  'detail.plugin.upgradeFailed': { zh: '升级失败：{msg}', en: 'Failed to upgrade: {msg}' },
  'detail.plugin.removeConfirmTitle': { zh: '卸载插件', en: 'Uninstall plugin' },
  'detail.plugin.removeConfirmBody': {
    zh: '确认卸载「{name}」？卸载后该实例将不再加载此插件。',
    en: 'Uninstall "{name}"? This instance will no longer load it.'
  },
  'detail.plugin.restartTitle': { zh: '需要重启实例', en: 'Restart required' },
  'detail.plugin.restartBody': {
    zh: '「{name}」的改动需要重启实例后才能生效（该实例未启用热更新，运行中的实例无法加载插件改动）。是否立即重启？',
    en: 'Changes to "{name}" take effect only after a restart: this instance runs without hot reload, so a running instance cannot load plugin changes. Restart now?'
  },
  'detail.plugin.restartNow': { zh: '立即重启', en: 'Restart now' },
  'detail.plugin.restartLater': { zh: '稍后手动', en: 'Later' },
  /** 实例未运行：改动已保存，下次启动自然生效。 */
  'detail.plugin.savedHint': {
    zh: '「{name}」已保存，启动实例后生效。',
    en: '"{name}" is saved and takes effect when the instance starts.'
  },
  /** 运行中且 HMR 可用（全新安装/启用禁用/卸载）：已热生效，无需重启。 */
  'detail.plugin.appliedHint': {
    zh: '「{name}」已即时生效，无需重启实例。',
    en: '"{name}" is already active — no restart needed.'
  },
  'detail.plugin.mutationDone': { zh: '插件已更新', en: 'Plugin updated' },
  'detail.plugin.installTitle': { zh: '安装插件', en: 'Install plugin' },
  'detail.plugin.installLabel': { zh: '插件标识', en: 'Plugin identifier' },
  'detail.plugin.installPlaceholder': {
    zh: 'npm 名 / name@version / github:owner/repo / file:路径',
    en: 'npm name / name@version / github:owner/repo / file:path'
  },
  'detail.plugin.installHint': {
    zh: '支持 npm 包名（可带 @版本）、GitHub 仓库、本地路径。',
    en: 'Accepts an npm name (optionally @version), a GitHub repo, or a local path.'
  },
  // —— 安装两步：第一步（确定版本）——
  'detail.plugin.installSource': { zh: '安装源', en: 'Install source' },
  'detail.plugin.installResolve': { zh: '确定', en: 'Confirm' },
  'detail.plugin.installResolving': { zh: '解析中…', en: 'Resolving…' },
  'detail.plugin.installResolveHint': {
    zh: '未指定版本时按所选安装源解析最新版',
    en: 'Without a version, the newest release is resolved from the selected source'
  },
  'detail.plugin.installSafety': {
    zh: '请确认插件来源可信。插件在本机以你的权限运行，来源不明的插件可能损坏 DSH，或读取和泄露你的数据。',
    en: 'Make sure the plugin source is trustworthy. Plugins run on this machine with your permissions, so an unknown plugin can damage DSH or read and leak your data.'
  },
  'detail.plugin.resolveFailed': {
    zh: '无法解析该版本：{msg}',
    en: 'Cannot resolve the version: {msg}'
  },
  // —— 安装/升级确认区（第二步，两者共用）——
  'detail.plugin.confirmInstallSection': { zh: '将安装', en: 'To install' },
  'detail.plugin.confirmUpgradeSection': { zh: '将升级到', en: 'To upgrade to' },
  'detail.plugin.confirmPlugin': { zh: '插件', en: 'Plugin' },
  'detail.plugin.confirmVersion': { zh: '版本', en: 'Version' },
  'detail.plugin.confirmSourceNpm': { zh: 'npm registry', en: 'npm registry' },
  'detail.plugin.confirmSourceGithub': { zh: 'GitHub 仓库', en: 'GitHub repository' },
  'detail.plugin.confirmSourceFile': { zh: '本地路径', en: 'Local path' },
  'detail.plugin.confirmDownloads': { zh: '近 30 天下载', en: 'Downloads (30d)' },
  'detail.plugin.confirmDownloadsNote': { zh: 'npm 官方口径', en: 'npm official' },
  'detail.plugin.confirmCompat': { zh: 'dsh 兼容', en: 'dsh compatibility' },
  'detail.plugin.confirmCompatOk': { zh: '满足', en: 'satisfied' },
  'detail.plugin.confirmCompatFail': { zh: '不满足', en: 'not satisfied' },
  'detail.plugin.confirmCompatUnknown': { zh: '无法判定', en: 'cannot be determined' },
  'detail.plugin.confirmInstalledSame': {
    zh: '已装 {version} · 版本已相符（重装）',
    en: 'Installed {version} · same version (reinstall)'
  },
  'detail.plugin.confirmUninstalled': { zh: '未安装', en: 'Not installed' },
  'detail.plugin.confirmRisk': {
    zh: '我已知晓该风险，仍要安装',
    en: 'I understand the risk and still want to install'
  },
  'detail.plugin.confirmEnableAfter': { zh: '安装后启用', en: 'Enable after install' },
  'detail.plugin.confirmEnableAfterHint': {
    zh: '取消则只安装，插件落在「已禁用」状态',
    en: 'When cleared, the plugin is installed but left disabled'
  },
  'detail.plugin.confirmInputChanged': {
    zh: '输入变更后需重新确定',
    en: 'Confirm again after editing the identifier'
  },
  'detail.plugin.installAction': { zh: '安装 {version}', en: 'Install {version}' },
  'detail.plugin.reinstallAction': { zh: '重装 {version}', en: 'Reinstall {version}' },
  'detail.plugin.upgradeTitle': { zh: '升级插件', en: 'Upgrade plugin' },
  'detail.plugin.upgradeKeepState': {
    zh: '升级不改变启用状态：当前已禁用的插件升级后仍为禁用。',
    en: 'Upgrading does not change the enabled state: a disabled plugin stays disabled.'
  },
  'detail.plugin.upgradeInterruptNote': {
    zh: '升级会先停止并移除旧版本，再安装新版本；依赖该插件的功能会短暂中断',
    en: 'Upgrading stops and removes the old version before installing the new one; features that depend on the plugin are briefly interrupted'
  },
  'detail.plugin.upgradeRunningNote': {
    zh: '升级进行中，不可取消；可放到后台，完成后会提示结果',
    en: 'Upgrade in progress and cannot be cancelled; send it to the background and you will be notified when it finishes'
  },
  'detail.plugin.upgradeBackground': { zh: '放到后台', en: 'Send to background' },
  'detail.plugin.upgradeFailedInline': { zh: '升级失败：{msg}', en: 'Failed to upgrade: {msg}' },
  // —— 更新内容（确认区懒加载）——
  'detail.plugin.releaseNotesTitle': { zh: '更新内容', en: "What's new" },
  'detail.plugin.releaseNotesLoading': { zh: '获取中…', en: 'Loading…' },
  'detail.plugin.releaseNotesEmpty': {
    zh: '未找到该版本的更新说明',
    en: 'No release notes found for this version'
  },
  'detail.plugin.releaseNotesTruncated': {
    zh: '内容过长已截断，完整说明见发布页',
    en: 'Truncated for length; see the release page for the full text'
  },
  'detail.plugin.releaseNotesOpen': { zh: '打开发布页', en: 'Open release page' },
  'detail.plugin.releaseNotesSourceGithub': { zh: 'GitHub Release', en: 'GitHub release' },
  'detail.plugin.releaseNotesSourceChangelog': { zh: '仓库 CHANGELOG', en: 'Repository CHANGELOG' },
  'detail.plugin.installSubmit': { zh: '安装', en: 'Install' },
  'detail.plugin.installing': { zh: '安装中…', en: 'Installing…' },
  'detail.plugin.installed': { zh: '已安装', en: 'Installed' },
  'detail.plugin.source.npm': { zh: 'npm', en: 'npm' },
  'detail.plugin.source.github': { zh: 'GitHub', en: 'GitHub' },
  'detail.plugin.source.file': { zh: '本地', en: 'local' },
  'detail.plugin.source.unknown': { zh: '未知来源', en: 'unknown' },
  'detail.plugin.field.name': { zh: '名称', en: 'Name' },
  'detail.plugin.field.description': { zh: '简介', en: 'Description' },
  'detail.plugin.field.author': { zh: '作者', en: 'Author' },
  'detail.plugin.field.license': { zh: '许可', en: 'License' },
  'detail.plugin.field.github': { zh: 'GitHub', en: 'GitHub' },
  'detail.plugin.field.npm': { zh: 'npm', en: 'npm' },
  'detail.plugin.field.published': { zh: '发布时间', en: 'Published' },
  'detail.plugin.field.compat': { zh: '兼容版本', en: 'Compatibility' },
  'detail.plugin.field.deps': { zh: '第三方依赖', en: 'Dependencies' },
  'detail.plugin.publishedUnknown': { zh: '点检查升级获取', en: 'Run check to fetch' },
  'detail.plugin.depsNone': { zh: '无', en: 'none' },
  'detail.plugin.openLinkFailed': { zh: '打开链接失败', en: 'Failed to open link' },
  'detail.plugin.log.installing': { zh: '开始安装插件 {spec}', en: 'Installing plugin {spec}' },
  'detail.plugin.log.installed': { zh: '插件已安装：{spec}', en: 'Plugin installed: {spec}' },
  'detail.plugin.log.installFailed': {
    zh: '插件安装失败（{spec}）：{msg}',
    en: 'Failed to install {spec}: {msg}'
  },
  'detail.plugin.log.upgrading': {
    zh: '开始升级 {name} 到 {version}',
    en: 'Upgrading {name} to {version}'
  },
  'detail.plugin.log.upgraded': {
    zh: '{name} 已升级到 {version}',
    en: '{name} upgraded to {version}'
  },
  'detail.plugin.log.upgradeFailed': {
    zh: '{name} 升级失败：{msg}',
    en: 'Failed to upgrade {name}: {msg}'
  },
  'detail.plugin.log.removing': { zh: '开始卸载 {name}', en: 'Uninstalling {name}' },
  'detail.plugin.log.removed': { zh: '已卸载 {name}', en: '{name} uninstalled' },
  'detail.plugin.log.removeFailed': {
    zh: '{name} 卸载失败：{msg}',
    en: 'Failed to uninstall {name}: {msg}'
  },
  'detail.plugin.log.enabling': { zh: '正在启用 {name}', en: 'Enabling {name}' },
  'detail.plugin.log.disabling': { zh: '正在禁用 {name}', en: 'Disabling {name}' },
  'detail.plugin.log.enabled': { zh: '已启用 {name}', en: '{name} enabled' },
  'detail.plugin.log.disabled': { zh: '已禁用 {name}', en: '{name} disabled' },
  'detail.plugin.log.enableFailed': {
    zh: '{name} 启用失败：{msg}',
    en: 'Failed to enable {name}: {msg}'
  },
  'detail.plugin.log.disableFailed': {
    zh: '{name} 禁用失败：{msg}',
    en: 'Failed to disable {name}: {msg}'
  },
  'detail.plugin.log.restartHint': {
    zh: '{name} 的改动需重启实例后生效',
    en: 'Changes to {name} take effect after restarting the instance'
  },
  'detail.plugin.log.savedHint': {
    zh: '{name} 已保存，启动实例后生效',
    en: '{name} saved; takes effect when the instance starts'
  },
  'detail.plugin.log.appliedHint': {
    zh: '{name} 已即时生效，无需重启',
    en: '{name} is already active; no restart needed'
  },
  /** 启用不兼容插件时主进程先授予精确版本豁免（allow-version --accept-risk），信息栏留痕。 */
  'detail.plugin.log.exemptionGranted': {
    zh: '已授予 {name}@{version} 对 dsh {dshVersion} 的兼容豁免（allow-version --accept-risk）',
    en: 'Granted compatibility exemption for {name}@{version} on dsh {dshVersion} (allow-version --accept-risk)'
  },
  /** 检查更新的信息栏记录：有更新与异常写入，已最新不写（避免每次检查刷屏）。 */
  'detail.plugin.log.updateAvailable': {
    zh: '检查更新：{name} 有新版本 {latest}（当前 {current}）',
    en: 'Update check: {name} has a new version {latest} (installed {current})'
  },
  'detail.plugin.log.incompatible': {
    zh: '检查异常：{name} 新版 {latest} 要求 dsh {peer}，当前 {current}',
    en: 'Check warning: {name} {latest} requires dsh {peer}, current {current}'
  },
  'detail.plugin.log.checkFailed': {
    zh: '检查更新失败：{name} — {msg}',
    en: 'Update check failed: {name} — {msg}'
  },
  'detail.plugin.log.loadFailed': {
    zh: '插件列表加载失败：{msg}',
    en: 'Failed to load plugin list: {msg}'
  },
  'detail.plugin.log.checkAllUpdates': {
    zh: '检查更新完成：{count} 个插件有新版本（{list}）',
    en: 'Update check complete: {count} plugin(s) with new versions ({list})'
  },
  'detail.plugin.log.checkAllIncompatible': {
    zh: '检查异常：{count} 个插件新版与当前 dsh 不兼容（{list}）',
    en: 'Check warning: {count} plugin(s) incompatible with the current dsh ({list})'
  },
  'detail.plugin.log.checkAllFailed': {
    zh: '检查更新失败：{count} 个插件（{list}）',
    en: 'Update check failed for {count} plugin(s) ({list})'
  },
  'detail.plugin.exemptionGrantedTitle': {
    zh: '已授予兼容豁免',
    en: 'Compatibility exemption granted'
  },
  'detail.plugin.exemptionGrantedBody': {
    zh: '「{name}@{version}」与 dsh {dshVersion} 不兼容，已按你的操作授予豁免（接受风险）并启用；运行可能崩溃或丢失数据。',
    en: '"{name}@{version}" is incompatible with dsh {dshVersion}; an exemption was granted at your action (risk accepted) and the plugin was enabled. It may crash or lose data.'
  },
  'detail.plugin.upgradeBlocked': {
    zh: '{latest} 要求 dsh {peer}，当前 {current} 不满足，已阻止升级',
    en: 'v{latest} requires dsh {peer}; current {current} does not satisfy it — upgrade blocked'
  },

  'runtime.confirm.downloadTitle': {
    zh: '未找到可复用的 dsh 运行时',
    en: 'No reusable dsh runtime found'
  },
  'runtime.confirm.downloadBody': {
    zh: 'hub 隔离目录与本机 PATH 上都没有可用的 dsh，需要下载 @deepseek-ai/dsh@{version}（首次下载可能较慢）。是否继续？',
    en: 'No usable dsh was found in the hub store or on PATH. @deepseek-ai/dsh@{version} must be downloaded (the first download can be slow). Continue?'
  },
  'runtime.confirm.downloadAccept': { zh: '下载并启动', en: 'Download & start' },
  'runtime.confirm.downloadHint': {
    zh: '取消则跳过下载，本次启动取消。',
    en: 'Cancelling skips the download and stops this start.'
  },
  'runtime.confirm.downloadRegistry': {
    zh: '下载来源：{registry}',
    en: 'Download from: {registry}'
  },
  'runtime.confirm.downloadRegistryDefault': {
    zh: '下载来源：系统 npm 默认配置',
    en: 'Download from: default npm configuration'
  },
  'runtime.confirm.upgradeTitle': {
    zh: '升级系统默认 dsh？',
    en: 'Upgrade the system default dsh?'
  },
  'runtime.confirm.upgradeBody': {
    zh: '该实例使用公共空间 ~/.dsh，运行的是 PATH 上的系统默认 dsh（当前 {current}）。升级将全局更新为 @deepseek-ai/dsh@{latest}，所有使用系统默认 dsh 的实例与终端都会跟随。是否继续？',
    en: 'This instance uses the shared ~/.dsh space and runs the system default dsh from PATH (currently {current}). The upgrade updates it globally to @deepseek-ai/dsh@{latest}; every instance and terminal using the system default dsh will follow. Continue?'
  },
  'runtime.confirm.upgradeAccept': { zh: '升级', en: 'Upgrade' },
  'runtime.confirm.upgradeHint': {
    zh: '拒绝则不执行任何升级。',
    en: 'Declining performs no upgrade.'
  },
  'detail.log.title': { zh: '安装与运行日志', en: 'Install & runtime log' },
  'detail.log.empty': { zh: '暂无日志', en: 'No log yet' },
  'detail.log.clear': { zh: '清空', en: 'Clear' },
  'detail.log.copy': { zh: '复制', en: 'Copy' },
  'detail.log.copied': { zh: '日志已复制', en: 'Log copied' },
  'detail.log.more': { zh: '更多', en: 'More' },
  'detail.log.openDir': { zh: '打开日志目录', en: 'Open log folder' },
  'detail.port': { zh: '端口', en: 'Port' },
  'detail.runCommand': { zh: '运行命令', en: 'Run command' },
  'detail.dataDirTitle': { zh: '该实例隔离的 DSH_HOME', en: 'Isolated DSH_HOME for this instance' },
  'detail.stop': { zh: '关闭实例', en: 'Stop instance' },
  'detail.stopping': { zh: '关闭中…', en: 'Stopping…' },
  'detail.stopFailed': { zh: '关闭失败', en: 'Failed to stop' },
  'detail.stopped': { zh: '实例已关闭', en: 'Instance stopped' },
  'detail.restart': { zh: '重启实例', en: 'Restart instance' },
  'detail.restarting': { zh: '重启中…', en: 'Restarting…' },
  'detail.restartFailed': { zh: '重启失败', en: 'Failed to restart' },
  'detail.disconnect': { zh: '断开工作区', en: 'Disconnect workspace' },
  'detail.openInBrowser': { zh: '在浏览器中打开', en: 'Open in browser' },
  'detail.openInBrowserFailed': { zh: '在浏览器中打开失败', en: 'Failed to open in browser' },
  'detail.copyToken': { zh: '复制 token', en: 'Copy token' },
  'detail.copyTokenFailed': { zh: '复制 token 失败', en: 'Failed to copy token' },
  'detail.tokenCopied': { zh: '访问 token 已复制', en: 'Access token copied' },
  'detail.errTokenLocalOnly': {
    zh: '只有本机实例支持复制访问 token',
    en: 'Only local instances support copying an access token'
  },
  'detail.errTokenMissing': {
    zh: '没有可复制的访问 token',
    en: 'No access token to copy'
  },
  'detail.errCopyTokenUnavailable': {
    zh: '复制访问 token 不可用',
    en: 'Copying the access token is unavailable'
  },
  'detail.openDir': { zh: '打开实例目录', en: 'Open instance folder' },
  'detail.openDirFailed': { zh: '打开实例目录失败', en: 'Failed to open instance folder' },
  'detail.openLogDirFailed': { zh: '打开日志目录失败', en: 'Failed to open log folder' },
  'detail.disconnected': { zh: '工作区已断开', en: 'Workspace disconnected' },
  'detail.externalTitle': {
    zh: '本机已在运行的 dsh web',
    en: 'dsh web already running on this machine'
  },
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
  'detail.externalTokenBody': {
    zh: '其他进程重启 dsh 后，访问 token 可能变化。粘贴最新 token 或完整链接后重新连接。',
    en: 'The access token can change when another process restarts dsh. Paste the latest token or full URL, then reconnect.'
  },
  'detail.externalTokenUpdate': { zh: '更新 token 并连接', en: 'Update token and connect' },
  'detail.externalTokenUpdating': { zh: '正在更新…', en: 'Updating…' },
  'detail.externalDataDir': {
    zh: '（外部进程，由你自己管理）',
    en: '(external process, managed by you)'
  },
  'detail.deleteInstance': { zh: '删除实例', en: 'Delete instance' },
  'detail.deleteTitle': { zh: '删除实例', en: 'Delete instance' },
  'detail.deleteCannotUndo': { zh: '此操作不可撤销', en: 'This cannot be undone' },
  'detail.deleteSpace': {
    zh: '同时将隔离空间移入废纸篓',
    en: 'Also move the isolated space to Trash'
  },
  'detail.missingHint': { zh: '实例不存在或已被删除。', en: 'This instance no longer exists.' },
  'detail.logout': { zh: '登出', en: 'Sign out' },
  'detail.deleted': { zh: '「{name}」已删除', en: 'Deleted "{name}"' },
  // 直连 HTTP 实例持续显示数据面明文警告。
  'detail.cleartextWarning': {
    zh: '未加密连接：直连 http:// 端点的数据面为明文，密码、动态验证码与会话 Cookie 都会以明文经过网络。http 实例完全可用；若希望数据面也被加密，https 端点或 SSH 隧道更稳妥。',
    en: 'Unencrypted connection: a direct http:// endpoint has a cleartext data plane, so the password, verification code and session cookie travel over the network unencrypted. http instances work fine; an https endpoint or an SSH tunnel is simply more private if you want the data plane encrypted too.'
  },
  'detail.cleartextBadge': { zh: '未加密连接', en: 'Unencrypted' },
  // —— 实例编辑 ——
  'edit.openButton': { zh: '编辑', en: 'Edit' },
  'edit.title': { zh: '编辑实例', en: 'Edit instance' },
  'edit.sub': {
    zh: '{name}：连接方式创建后不可更改；其余字段随时可改。',
    en: '{name}: the transport cannot be changed after creation; other fields can be edited any time.'
  },
  'edit.nameLabel': { zh: '名称', en: 'Name' },
  'edit.nameRequired': { zh: '名称不能为空', en: 'Name is required' },
  'edit.notesLabel': { zh: '备注', en: 'Notes' },
  'edit.authModeLabel': { zh: '认证方式', en: 'Authentication' },
  'edit.authModeAuto': { zh: '自动探测', en: 'Auto-detect' },
  'edit.authModeNone': { zh: '无需登录', en: 'No login' },
  'edit.authModeGateway': { zh: '网关登录', en: 'Gateway login' },
  'edit.authModeHint': {
    zh: '自动探测在连接时识别是否需要登录',
    en: 'Auto-detect probes the endpoint when connecting'
  },
  'edit.portLabel': { zh: '端口', en: 'Port' },
  'edit.portPlaceholder': { zh: '留空 = 自动分配', en: 'Empty = auto-assign' },
  'edit.launcherLabel': { zh: '启动器', en: 'Launcher' },
  'edit.launcherHint': {
    zh: 'Hub 固定使用 web、回环地址、端口和 --no-open；保存后下次启动生效。',
    en: 'Hub fixes web, the loopback host, port, and --no-open. Changes apply on the next start.'
  },
  'edit.profileLabel': { zh: 'Profile', en: 'Profile' },
  'edit.profilePlaceholder': { zh: '留空 = web', en: 'Empty = web' },
  'edit.profileInvalid': {
    zh: 'Profile 只能使用相对路径，且不能包含 .. 或以 - 开头',
    en: 'Profile must be a relative path without .. or a leading -'
  },
  'edit.registryInvalid': {
    zh: '镜像地址必须是 https URL（本地镜像允许回环 http）',
    en: 'The mirror must be an https URL (loopback http is allowed for local mirrors)'
  },
  'edit.autoStartLabel': { zh: '应用启动时自动拉起', en: 'Start automatically with the app' },
  'edit.hostLabel': { zh: '主机', en: 'Host' },
  'edit.usernameLabel': { zh: '用户名', en: 'Username' },
  'edit.remotePortLabel': { zh: '远端端口', en: 'Remote port' },
  'edit.identityLabel': { zh: '私钥路径', en: 'Identity file' },
  'edit.identityPlaceholder': {
    zh: '留空 = 默认（agent 优先）',
    en: 'Empty = default (agent first)'
  },
  'edit.sshRequired': {
    zh: '主机、用户名与远端端口不能为空',
    en: 'Host, username and remote port are required'
  },
  'edit.endpointLabel': { zh: '端点 URL', en: 'Endpoint URL' },
  'edit.endpointHint': {
    zh: '仅支持 http/https，禁止内嵌凭据',
    en: 'http/https only; inline credentials are rejected'
  },
  'edit.endpointRequired': { zh: '端点 URL 不能为空', en: 'Endpoint URL is required' },
  'edit.proxyTypeLabel': { zh: '代理', en: 'Proxy' },
  'edit.proxyHint': {
    zh: '改动在实例下次启动时生效；密码只写入系统凭据保险库。',
    en: 'Changes take effect on the next start; the password is stored only in the system credential vault.'
  },
  'edit.proxyRequired': { zh: '代理主机不能为空', en: 'Proxy host is required' },
  'edit.proxyPortInvalid': {
    zh: '代理端口必须在 1–65535 之间',
    en: 'Proxy port must be between 1 and 65535'
  },
  'edit.proxyPasswordKeep': {
    zh: '留空保持不变',
    en: 'Leave empty to keep the saved password'
  },
  'edit.proxyClearPassword': {
    zh: '清除已保存的代理密码',
    en: 'Forget the saved proxy password'
  },
  'edit.proxyPasswordHint': {
    zh: '代理用户名与密码只在需要认证时填写；清空代理会一并清除密码。',
    en: 'Fill in username and password only if the proxy requires authentication; removing the proxy also forgets the password.'
  },
  'edit.proxyUsernameRequired': {
    zh: '填写代理密码时也需要填写代理用户名',
    en: 'A proxy username is required when a proxy password is set'
  },
  'edit.proxyPasswordRequired': {
    zh: '新增或修改代理用户名时，需要同时填写密码',
    en: 'A password is required when adding or changing the proxy username'
  },
  'edit.proxyPasswordClearConflict': {
    zh: '清除代理密码时，请同时移除代理用户名或关闭代理',
    en: 'To clear the proxy password, also remove the username or turn the proxy off'
  },
  'edit.saved': { zh: '已保存', en: 'Saved' },
  'edit.failed': { zh: '保存失败', en: 'Failed to save' },
  'edit.restartHint': {
    zh: '实例运行中：端口与配置改动将在下次启动生效。',
    en: 'Instance is running: port and config changes take effect on next start.'
  },
  'detail.deleteBody': {
    zh: '删除后本地保存的登录信息与连接记录会一并移除，远端 dsh 本身不受影响。',
    en: 'Local sign-in data and connection history are removed too; the remote dsh itself is unaffected.'
  },
  'detail.delete': { zh: '删除', en: 'Delete' },

  // —— SSH 指纹/口令对话框 ——
  'ssh.hostKeyChangedTitle': { zh: '服务器指纹已变化', en: 'Server fingerprint changed' },
  'ssh.hostKeyTitle': { zh: '连接安全确认', en: 'Confirm connection security' },
  'ssh.hostKeyChangedSub': { zh: '与此前信任的不一致', en: 'differs from what was trusted before' },
  'ssh.hostKeyNewSub': {
    zh: '首次连接前需核对身份',
    en: 'verify the identity before first connecting'
  },
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
  'ssh.trustAndConnect': {
    zh: '这是我的服务器，信任并连接',
    en: 'This is my server — trust and connect'
  },
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
  'home.statInstances': {
    zh: '个实例，本地 / SSH / 远程统一入口',
    en: 'instances — one place for local, SSH and remote'
  },
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
  'home.listErrorTitle': { zh: '实例列表加载失败', en: 'Failed to load instance list' },
  'home.listErrorRetry': { zh: '重试', en: 'Retry' },
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
  'detect.none': {
    zh: '无需登录认证，可直接访问',
    en: 'No authentication required; reachable directly'
  },
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
  'tray.status': { zh: '{count} 个实例运行中', en: '{count} running' },

  // —— 实例分区下载 ——
  'download.save.title': { zh: '保存下载的文件', en: 'Save downloaded file' },
  'download.save.button': { zh: '保存', en: 'Save' },
  'download.interrupted.title': { zh: '下载中断', en: 'Download interrupted' },
  'download.interrupted.body': {
    zh: '{name} 未能保存完成，连接可能已断开。',
    en: '{name} did not save completely; the connection may have dropped.'
  },

  // —— 关于 ——
  'about.title': { zh: '关于 DSH Hub', en: 'About DSH Hub' },
  'about.open': { zh: '关于', en: 'About' },
  'about.sectionHint': {
    zh: '版本、项目主页、运行组件与第三方依赖',
    en: 'Version, homepage, runtime components and dependencies'
  },
  'about.homepage': { zh: '项目主页', en: 'Homepage' },
  'about.build': { zh: '构建版本', en: 'Build' },
  'about.buildTime': { zh: '打包时间', en: 'Build time' },
  'about.components': { zh: '运行组件', en: 'Runtime components' },
  'about.dependencies': { zh: '第三方依赖', en: 'Third-party dependencies' },
  'about.depsShow': { zh: '展开', en: 'Show' },
  'about.depsHide': { zh: '收起', en: 'Hide' },
  'about.copyright': { zh: '版权所有 © 2026 xbzbing', en: 'Copyright © 2026 xbzbing' },

  // —— 插件安装安全检查 ——
  'detail.plugin.security.title': { zh: '安全检查', en: 'Security check' },
  'detail.plugin.security.refresh': { zh: '重新检查', en: 'Re-check' },
  'detail.plugin.security.refreshing': { zh: '检查中…', en: 'Checking…' },
  'detail.plugin.security.checking': {
    zh: '正在下载并检查插件包…',
    en: 'Downloading and checking the plugin package…'
  },
  'detail.plugin.security.checkFailed': {
    zh: '安全检查未完成：{msg}',
    en: 'Security check did not finish: {msg}'
  },
  'detail.plugin.security.verdict.pass': { zh: '未发现明显风险', en: 'No obvious risks found' },
  'detail.plugin.security.verdict.warn': {
    zh: '有 {count} 项需要留意',
    en: '{count} items need attention'
  },
  'detail.plugin.security.verdict.blocked': { zh: '已阻止安装', en: 'Installation blocked' },
  'detail.plugin.security.verdict.unavailable': {
    zh: '关键检查未完成',
    en: 'Essential checks incomplete'
  },
  'detail.plugin.security.verdict.disabled': {
    zh: '安装前安全检查已关闭',
    en: 'Pre-install security check is off'
  },
  'detail.plugin.security.summary.pass': {
    zh: '未发现明显风险。静态检查只能降低风险，不能保证插件安全。',
    en: 'No obvious risks found. Static checks reduce risk but cannot guarantee a plugin is safe.'
  },
  'detail.plugin.security.summary.warn': {
    zh: '以下项目需要留意，确认后可继续安装。',
    en: 'Review the items below; you can still install after confirming.'
  },
  'detail.plugin.security.summary.blocked': {
    zh: '发现高风险问题，无法继续安装。请更换版本或安装源。',
    en: 'High-risk issues found; installation cannot continue. Choose another version or source.'
  },
  'detail.plugin.security.summary.unavailable': {
    zh: '关键检查未能完成，无法确认包体是否安全；确认后可继续安装。',
    en: 'Essential checks did not finish, so the package cannot be verified; you can still install after confirming.'
  },
  'detail.plugin.security.summary.disabled': {
    zh: '安装前安全检查已关闭，本次不会检查插件来源与内容。',
    en: 'The pre-install security check is off; this plugin will not be checked.'
  },
  'detail.plugin.security.disabledHint': {
    zh: '可在「设置 → 安全」中重新开启。',
    en: 'You can re-enable it in Settings → Security.'
  },
  'detail.plugin.security.backToEdit': { zh: '返回修改', en: 'Back to edit' },
  'detail.plugin.security.checkingButton': { zh: '检查中…', en: 'Checking…' },
  'detail.plugin.security.acknowledge': {
    zh: '仍要安装 {version}',
    en: 'Install anyway {version}'
  },
  'detail.plugin.security.acknowledgeUpgrade': {
    zh: '仍要升级到 {version}',
    en: 'Upgrade anyway to {version}'
  },
  'detail.plugin.security.details': { zh: '查看检查详情', en: 'View check details' },
  'detail.plugin.security.partial': { zh: '部分检查未完成', en: 'Some checks did not finish' },
  'detail.plugin.security.privacy': {
    zh: '检查在本机完成，不会上传插件代码。静态检查只能降低风险，不能保证安全；插件运行时拥有你的权限。',
    en: 'Checks run locally and never upload plugin code. Static checks reduce risk but cannot guarantee safety; plugins run with your permissions.'
  },
  'detail.plugin.security.pnpmNote': {
    zh: 'dsh 的 pnpm 默认会阻止未放行的依赖构建脚本；只有 profile 的 allowBuilds 放行时才会执行。',
    en: "dsh's pnpm blocks dependency lifecycle scripts unless the profile's allowBuilds permits them."
  },
  'detail.plugin.security.fact.source': { zh: '来源与发布者', en: 'Source and publisher' },
  'detail.plugin.security.fact.integrity': { zh: '包体完整性', en: 'Package integrity' },
  'detail.plugin.security.fact.scripts': { zh: '安装脚本', en: 'Install scripts' },
  'detail.plugin.security.fact.content': { zh: '代码特征', en: 'Code characteristics' },
  'detail.plugin.security.fact.dependencies': { zh: '名称与依赖', en: 'Name and dependencies' },
  'detail.plugin.security.fact.vulnerabilities': { zh: '已知漏洞', en: 'Known vulnerabilities' },
  'detail.plugin.security.facts.none': { zh: '无', en: 'None' },
  'detail.plugin.security.facts.downloads': {
    zh: '近 30 天 {count} 次下载',
    en: '{count} downloads in 30 days'
  },
  'detail.plugin.security.facts.versions': { zh: '{count} 个版本', en: '{count} versions' },
  'detail.plugin.security.facts.size': {
    zh: '{size} / {files} 个文件',
    en: '{size} / {files} files'
  },
  'detail.plugin.security.facts.publisher': { zh: '发布者 {name}', en: 'Publisher {name}' },
  'detail.plugin.security.facts.capabilities': {
    zh: '命令 {spawn} · 网络 {network} · 动态求值 {eval} · 敏感读取 {sensitive}',
    en: 'Commands {spawn} · Network {network} · Dynamic eval {eval} · Sensitive reads {sensitive}'
  },
  'detail.plugin.security.facts.scripts': { zh: '包含 {names}', en: 'Includes {names}' },
  'detail.plugin.security.facts.deps': {
    zh: '{count} 个直接依赖',
    en: '{count} direct dependencies'
  },
  'detail.plugin.security.facts.nonRegistry': {
    zh: ' · {count} 个非 registry 依赖',
    en: ' · {count} non-registry dependencies'
  },
  'detail.plugin.security.facts.native': {
    zh: ' · {count} 个原生模块',
    en: ' · {count} native modules'
  },
  'detail.plugin.security.level.pass': { zh: '通过', en: 'Pass' },
  'detail.plugin.security.level.info': { zh: '提示', en: 'Info' },
  'detail.plugin.security.level.warn': { zh: '留意', en: 'Attention' },
  'detail.plugin.security.level.danger': { zh: '高风险', en: 'High risk' },
  'detail.plugin.security.level.blocked': { zh: '已阻止', en: 'Blocked' },
  'detail.plugin.security.level.skip': { zh: '未完成', en: 'Skipped' },
  'detail.plugin.security.check.source': { zh: '来源与发布者', en: 'Source and publisher' },
  'detail.plugin.security.check.integrity': { zh: '包体完整性', en: 'Package integrity' },
  'detail.plugin.security.check.reputation': { zh: '发布历史', en: 'Release history' },
  'detail.plugin.security.check.name': { zh: '名称与仿冒', en: 'Name and impersonation' },
  'detail.plugin.security.check.scripts': { zh: '安装脚本', en: 'Install scripts' },
  'detail.plugin.security.check.content': { zh: '代码内容', en: 'Code content' },
  'detail.plugin.security.check.dependencies': { zh: '依赖', en: 'Dependencies' },
  'detail.plugin.security.check.vulnerabilities': { zh: '已知漏洞', en: 'Known vulnerabilities' },
  'detail.plugin.security.code.source.npm': { zh: 'npm registry', en: 'npm registry' },
  'detail.plugin.security.code.source.mirror': { zh: '经镜像源', en: 'Via mirror' },
  'detail.plugin.security.code.source.publisher.changed': {
    zh: '发布者已变更',
    en: 'Publisher changed'
  },
  'detail.plugin.security.code.source.provenance.present': {
    zh: '构建来源可验证',
    en: 'Build provenance available'
  },
  'detail.plugin.security.code.source.provenance.lost': {
    zh: '新版本缺少构建来源证明',
    en: 'New version lost build provenance'
  },
  'detail.plugin.security.code.source.no-repository': {
    zh: '未声明代码仓库',
    en: 'No repository declared'
  },
  'detail.plugin.security.code.source.unavailable': {
    zh: '来源信息不可用',
    en: 'Source information unavailable'
  },
  'detail.plugin.security.code.source.github.pinned': {
    zh: 'GitHub 固定提交',
    en: 'GitHub commit pinned'
  },
  'detail.plugin.security.code.source.github.unpinned': {
    zh: 'GitHub 未固定提交，默认分支会变化',
    en: 'GitHub commit not pinned; the default branch can change'
  },
  'detail.plugin.security.code.source.local': { zh: '本地路径', en: 'Local path' },
  'detail.plugin.security.code.source.deprecated': {
    zh: '该版本已被标记为废弃',
    en: 'This version is deprecated'
  },
  'detail.plugin.security.code.integrity.ok': { zh: 'sha512 校验通过', en: 'sha512 verified' },
  'detail.plugin.security.code.integrity.github': {
    zh: 'GitHub 快照已解包',
    en: 'GitHub snapshot unpacked'
  },
  'detail.plugin.security.code.integrity.local': {
    zh: '本地文件已读取',
    en: 'Local files read'
  },
  'detail.plugin.security.code.integrity.mismatch': {
    zh: '包体哈希与 registry 声明不一致',
    en: 'Package hash does not match the registry'
  },
  'detail.plugin.security.code.integrity.manifest-mismatch': {
    zh: '包内 package.json 与 registry 元数据不一致',
    en: 'Package metadata does not match the registry'
  },
  'detail.plugin.security.code.integrity.unavailable': {
    zh: '完整性校验未完成',
    en: 'Integrity check did not finish'
  },
  'detail.plugin.security.code.tarball.unsafe-path': {
    zh: '包内包含越界路径',
    en: 'Package contains an unsafe path'
  },
  'detail.plugin.security.code.tarball.manifest-missing': {
    zh: '包内缺少 package.json',
    en: 'Package is missing package.json'
  },
  'detail.plugin.security.code.reputation.established': {
    zh: '版本与下载量正常',
    en: 'Release history looks normal'
  },
  'detail.plugin.security.code.reputation.new': {
    zh: '新发布的包',
    en: 'Recently published package'
  },
  'detail.plugin.security.code.reputation.low-downloads': {
    zh: '下载量较低',
    en: 'Low download count'
  },
  'detail.plugin.security.code.reputation.unknown': {
    zh: '新包、下载量低且无可验证来源',
    en: 'New, low-download package without verifiable source'
  },
  'detail.plugin.security.code.reputation.partial': {
    zh: '发布历史不完整',
    en: 'Release history incomplete'
  },
  'detail.plugin.security.code.name.ok': { zh: '未发现仿冒', en: 'No impersonation detected' },
  'detail.plugin.security.code.name.official-impersonation': {
    zh: '名称疑似模仿官方包',
    en: 'Name may impersonate an official package'
  },
  'detail.plugin.security.code.name.similar-installed': {
    zh: '与已装插件名称相似',
    en: 'Name is similar to an installed plugin'
  },
  'detail.plugin.security.code.name.scope-similar': {
    zh: '与已装插件 scope 相似',
    en: 'Scope is similar to an installed plugin'
  },
  'detail.plugin.security.code.name.skipped': { zh: '名称检查未完成', en: 'Name check skipped' },
  'detail.plugin.security.code.scripts.none': { zh: '无安装脚本', en: 'No install scripts' },
  'detail.plugin.security.code.scripts.present': {
    zh: '包含 {count} 个安装脚本',
    en: 'Includes {count} install scripts'
  },
  'detail.plugin.security.code.scripts.remote-fetch': {
    zh: '安装脚本会从网络获取并执行代码',
    en: 'Install script downloads and executes remote code'
  },
  'detail.plugin.security.code.scripts.skipped': {
    zh: '安装脚本检查未完成',
    en: 'Install script check skipped'
  },
  'detail.plugin.security.code.content.clean': {
    zh: '未发现高风险代码特征',
    en: 'No high-risk code patterns found'
  },
  'detail.plugin.security.code.content.capabilities': {
    zh: '可执行命令 {spawn} · 网络 {network} · 动态求值 {eval} · 敏感读取 {sensitive}',
    en: 'Commands {spawn} · Network {network} · Dynamic eval {eval} · Sensitive reads {sensitive}'
  },
  'detail.plugin.security.code.content.credential-exfil': {
    zh: '疑似读取凭据并外发',
    en: 'Possible credential access and exfiltration'
  },
  'detail.plugin.security.code.content.dynamic-eval': {
    zh: '动态求值',
    en: 'Dynamic evaluation'
  },
  'detail.plugin.security.code.content.exfil-domain': {
    zh: '连接可疑外发域名',
    en: 'Connects to a suspicious exfiltration domain'
  },
  'detail.plugin.security.code.content.miner': { zh: '疑似挖矿代码', en: 'Possible miner code' },
  'detail.plugin.security.code.content.native-binary': {
    zh: '包含原生二进制',
    en: 'Contains native binaries'
  },
  'detail.plugin.security.code.content.obfuscated-eval': {
    zh: '混淆代码后动态执行',
    en: 'Executes obfuscated code dynamically'
  },
  'detail.plugin.security.code.content.partial': {
    zh: '部分文件未扫描',
    en: 'Some files not scanned'
  },
  'detail.plugin.security.code.content.sensitive-read': {
    zh: '读取敏感路径',
    en: 'Reads sensitive paths'
  },
  'detail.plugin.security.code.content.skipped': {
    zh: '内容扫描未完成',
    en: 'Content scan skipped'
  },
  'detail.plugin.security.code.deps.registry-only': {
    zh: '依赖均来自 registry',
    en: 'All dependencies come from a registry'
  },
  'detail.plugin.security.code.deps.non-registry': {
    zh: '包含非 registry 依赖',
    en: 'Includes non-registry dependencies'
  },
  'detail.plugin.security.code.deps.native': { zh: '包含原生模块', en: 'Includes native modules' },
  'detail.plugin.security.code.dependencies.skipped': {
    zh: '依赖检查未完成',
    en: 'Dependency check skipped'
  },
  'detail.plugin.security.code.vuln.none': {
    zh: '未发现已知漏洞',
    en: 'No known vulnerabilities'
  },
  'detail.plugin.security.code.vuln.known': {
    zh: '发现 {count} 个已知漏洞',
    en: '{count} known vulnerabilities found'
  },
  'detail.plugin.security.code.vuln.malware': {
    zh: '命中 {count} 个恶意软件通告',
    en: '{count} malware advisories matched'
  },
  'detail.plugin.security.code.vuln.unavailable': {
    zh: '漏洞查询未完成',
    en: 'Vulnerability lookup did not finish'
  },
  'detail.plugin.security.code.vuln.skipped': {
    zh: '漏洞检查未完成',
    en: 'Vulnerability check skipped'
  },

  // —— 设置：插件安全检查 ——
  'settings.security': { zh: '安全', en: 'Security' },
  'settings.securityCheck': {
    zh: '安装插件前进行安全检查',
    en: 'Check plugins before installation'
  },
  'settings.securityCheckHint': {
    zh: '检查来源与发布者、包体完整性、安装脚本、代码特征、名称仿冒与已知漏洞。有风险时需要确认「仍要安装」，完整性异常会阻止安装。',
    en: 'Checks source and publisher, package integrity, install scripts, code characteristics, name impersonation and known vulnerabilities. Risks require an explicit "install anyway"; integrity failures block installation.'
  },
  'settings.securityCheckPrivacy': {
    zh: '检查在本机完成，不会上传插件代码。',
    en: 'Checks run locally and never upload plugin code.'
  }
} as const satisfies Record<string, Message>

export type MessageKey = keyof typeof MESSAGES

/** 从文案 key 推导的联合类型(供 UI 层与测试使用) */
export const MESSAGE_KEYS = Object.keys(MESSAGES) as MessageKey[]
