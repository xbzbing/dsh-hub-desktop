/**
 * release workflow 的输入校验与 CI 前置检查。
 *
 * 发布只能建立在两种事实上：输入版本与仓库里的版本/发布说明一致，且该提交的 CI 已经成功。
 * 本脚本只读，不写文件、不创建 tag、不碰 Release；任一条件不满足即非零退出。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findPlaceholders, parseReleaseNotes } from './lib.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
/** 发布前置所依赖的 workflow 名称，与 .github/workflows/ci.yml 的 `name` 一致。 */
export const CI_WORKFLOW = 'CI'

export class ReleaseInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReleaseInputError'
  }
}

/** 版本输入必须是纯 semver：发布说明按 `v<版本>.md` 取文件，不能带路径片段。 */
export function assertVersionInput(inputVersion) {
  const version = String(inputVersion ?? '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new ReleaseInputError(`版本输入不是纯 semver：${version === '' ? '（空）' : version}`)
  }
  return version
}

/**
 * 校验版本输入、package.json 与发布说明三者一致，且发布说明符合 windows-unsigned 契约。
 * @returns 解析后的发布说明
 */
export function assertReleaseInput(params) {
  const version = assertVersionInput(params.inputVersion)
  if (String(params.packageVersion) !== version) {
    throw new ReleaseInputError(
      `package.json 是 ${params.packageVersion}，输入是 ${version} —— 先提交版本变更再触发发布`
    )
  }
  const notes = parseReleaseNotes(params.notesText)
  if (notes.version !== version) {
    throw new ReleaseInputError(`发布说明写的是 v${notes.version}，输入是 v${version}`)
  }
  if (notes.distribution !== 'windows-unsigned') {
    throw new ReleaseInputError(
      `发布说明的分发方式是 ${notes.distribution}，发布 workflow 只产出 windows-unsigned`
    )
  }
  const placeholders = findPlaceholders(params.notesText)
  if (placeholders.length > 0) {
    throw new ReleaseInputError(`发布说明残留占位符：${placeholders.join(' / ')}`)
  }
  const installer = `DSH-Hub-Setup-${version}.exe`
  if (!notes.artifacts.includes(installer)) {
    throw new ReleaseInputError(`发布说明没有声明安装包 ${installer}`)
  }
  return notes
}

/** 判定该提交是否已有成功的 CI 运行；未找到、仍在跑或失败都不算通过。 */
export function ciConclusion(runs, headSha) {
  const matches = runs.filter((run) => run?.headSha === headSha)
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `没有找到 ${headSha.slice(0, 7)} 的 CI 运行记录 —— 等 push 触发的 CI 跑完再触发发布`
    }
  }
  const success = matches.find((run) => run.conclusion === 'success')
  if (success !== undefined) return { ok: true, run: success }
  const outcomes = matches.map((run) => run.conclusion ?? run.status ?? 'unknown').join(', ')
  return { ok: false, reason: `CI 尚未成功（${outcomes}）—— 修复后重新触发发布` }
}

function ghJson(args) {
  return JSON.parse(
    execFileSync('gh', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    })
  )
}

function main(argv) {
  const version = assertVersionInput(process.env.RELEASE_VERSION ?? '')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const notesText = readFileSync(join(ROOT, 'docs', 'releases', `v${version}.md`), 'utf8')
  const notes = assertReleaseInput({
    inputVersion: version,
    packageVersion: String(pkg.version ?? ''),
    notesText
  })
  console.log(
    `[release] 版本 ${version} 与 package.json、发布说明一致（${notes.artifacts.join(', ')}）`
  )

  if (!argv.includes('--require-ci')) return
  const headSha = process.env.GITHUB_SHA ?? ''
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new ReleaseInputError('缺少 GITHUB_SHA —— 该检查只能在 workflow 中运行')
  }
  const runs = ghJson([
    'run',
    'list',
    '--workflow',
    CI_WORKFLOW,
    '--commit',
    headSha,
    '--limit',
    '20',
    '--json',
    'headSha,status,conclusion'
  ])
  const verdict = ciConclusion(runs, headSha)
  if (verdict.ok === false) throw new ReleaseInputError(verdict.reason)
  console.log(`[release] CI 已成功（${headSha.slice(0, 7)}）`)
}

// Windows 下 argv[1] 是反斜杠盘符路径，必须经 pathToFileURL 归一后才能与 import.meta.url 比较
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[release] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
