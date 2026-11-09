/** GitHub API 请求头：`user-agent` 与 JSON `accept` 是硬要求；配置 GITHUB_TOKEN 可提高限额。 */
export function githubRequestHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim()
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-hub-desktop',
    ...(token !== undefined && token !== '' ? { authorization: `Bearer ${token}` } : {})
  }
}
