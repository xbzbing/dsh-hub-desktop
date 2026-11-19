import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ReleaseInputError,
  assertReleaseInput,
  assertVersionInput,
  ciConclusion
} from '../../scripts/release/ci-guard.mjs'

function notesFor(version = '0.1.18', extra: string[] = []): string {
  return [
    `# DSH Hub v${version}`,
    '',
    '- 发布日期: 2026-11-19',
    '',
    '## 分发方式',
    '',
    '- `windows-unsigned`',
    '',
    '## 产物',
    '',
    `- \`DSH-Hub-Setup-${version}.exe\`（Windows x64 NSIS 安装包，未签名）`,
    '- `SHA256SUMS.txt`（上述安装包的 SHA-256 校验清单）',
    ...extra
  ].join('\n')
}

describe('发布 workflow 的输入校验', () => {
  it('版本、package.json 与发布说明一致时返回解析结果', () => {
    const parsed = assertReleaseInput({
      inputVersion: '0.1.18',
      packageVersion: '0.1.18',
      notesText: notesFor('0.1.18')
    })
    expect(parsed.version).toBe('0.1.18')
    expect(parsed.distribution).toBe('windows-unsigned')
    expect(parsed.artifacts).toEqual(['DSH-Hub-Setup-0.1.18.exe', 'SHA256SUMS.txt'])
  })

  it('输入与 package.json 版本不一致时拒绝，提示先提交版本变更', () => {
    expect(() =>
      assertReleaseInput({
        inputVersion: '0.1.18',
        packageVersion: '0.1.17',
        notesText: notesFor('0.1.18')
      })
    ).toThrow(/package\.json 是 0\.1\.17/)
  })

  it('发布说明版本与输入不一致时拒绝', () => {
    expect(() =>
      assertReleaseInput({
        inputVersion: '0.1.18',
        packageVersion: '0.1.18',
        notesText: notesFor('0.1.17')
      })
    ).toThrow(/发布说明写的是 v0\.1\.17/)
  })

  it('发布说明完全没有安装包声明时由发布说明契约拒绝', () => {
    const text = notesFor('0.1.18').replace(/^- `DSH-Hub-Setup-0\.1\.18\.exe`.*$/m, '')
    expect(() =>
      assertReleaseInput({ inputVersion: '0.1.18', packageVersion: '0.1.18', notesText: text })
    ).toThrow(/必须声明 Windows 安装包/)
  })

  it('发布说明声明的安装包版本与输入不一致时拒绝', () => {
    const text = notesFor('0.1.18').replace('DSH-Hub-Setup-0.1.18.exe', 'DSH-Hub-Setup-0.1.17.exe')
    expect(() =>
      assertReleaseInput({ inputVersion: '0.1.18', packageVersion: '0.1.18', notesText: text })
    ).toThrow(/没有声明安装包 DSH-Hub-Setup-0\.1\.18\.exe/)
  })

  it('发布说明残留占位符时拒绝', () => {
    expect(() =>
      assertReleaseInput({
        inputVersion: '0.1.18',
        packageVersion: '0.1.18',
        notesText: `${notesFor('0.1.18')}\nTODO 补充说明\n`
      })
    ).toThrow(/占位符/)
  })

  it('版本输入含路径片段或非 semver 时拒绝', () => {
    expect(() => assertVersionInput('../0.1.18')).toThrow(ReleaseInputError)
    expect(() => assertVersionInput('v0.1.18')).toThrow(/semver/)
    expect(() => assertVersionInput('')).toThrow(/semver/)
  })
})

describe('发布前置的 CI 判定', () => {
  it('该提交有成功的 CI 时放行', () => {
    const verdict = ciConclusion(
      [
        { headSha: 'a'.repeat(40), conclusion: 'failure' },
        { headSha: 'a'.repeat(40), conclusion: 'success' }
      ],
      'a'.repeat(40)
    )
    expect(verdict.ok).toBe(true)
  })

  it('只认同一提交的记录，没有记录时拒绝', () => {
    const verdict = ciConclusion(
      [{ headSha: 'b'.repeat(40), conclusion: 'success' }],
      'a'.repeat(40)
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok === false) expect(verdict.reason).toMatch(/没有找到/)
  })

  it('CI 失败或仍在运行时拒绝，并带上状态', () => {
    const failed = ciConclusion(
      [{ headSha: 'a'.repeat(40), conclusion: 'failure' }],
      'a'.repeat(40)
    )
    expect(failed.ok).toBe(false)
    if (failed.ok === false) expect(failed.reason).toMatch(/failure/)

    const running = ciConclusion(
      [{ headSha: 'a'.repeat(40), status: 'in_progress', conclusion: null }],
      'a'.repeat(40)
    )
    expect(running.ok).toBe(false)
    if (running.ok === false) expect(running.reason).toMatch(/in_progress/)
  })
})

describe('release workflow 的触发与停点', () => {
  // Windows 的 checkout 是 CRLF；断言按 LF 写的 YAML 结构，先归一换行再匹配。
  const yml = readFileSync('.github/workflows/release.yml', 'utf8').replace(/\r\n/g, '\n')

  it('只允许手动触发，不监听 push 或 PR', () => {
    expect(yml).toMatch(/^on:\n {2}workflow_dispatch:/m)
    expect(yml).not.toMatch(/^\s{2}(push|pull_request|pull_request_target):/m)
  })

  it('用仓库 token 建 Draft，不自动发布', () => {
    expect(yml).toMatch(/permissions:\n {2}contents: write/m)
    expect(yml).toMatch(/node scripts\/release\/publish\.mjs/)
    expect(yml).not.toContain('--publish')
  })
})
