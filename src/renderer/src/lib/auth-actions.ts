/**
 * 认证动作的可见性判定（T11/T9）—— 纯函数,不 import electron/React,便于单测。
 *
 * 抽出来的理由(复审建议的最小测试缝):同一个判断此前在 DetailView 里**复制了三份**
 * (登录按钮 / 登出按钮 / 凭据卡),任何一处改口径都会让三块 UI 不一致;
 * 而且这类条件在无 DOM 环境的仓库里没有其它地方可测。
 *
 * 口径:
 * - `local` 实例是 hub 自己 spawn 的 dsh web,走 BrowserAuth(就绪 URL 里自带令牌),
 *   既没有网关会话可登出,也没有凭据可记 —— 认证动作整体不适用;
 * - `authMode: 'none'` 是用户显式声明「该实例不需要认证」,同样不展示。
 */
export function showAuthActions(record: {
  transport: string
  authMode: string
}): boolean {
  return record.transport !== 'local' && record.authMode !== 'none'
}
