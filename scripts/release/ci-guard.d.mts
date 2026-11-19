/** `ci-guard.mjs` 的类型声明（发布 workflow 的输入校验，供单测导入）。 */
import type { ReleaseNotes } from './lib.mjs'

export class ReleaseInputError extends Error {}

/** 版本输入必须是纯 semver；否则抛 ReleaseInputError。 */
export function assertVersionInput(inputVersion: string): string

/** 版本输入、package.json、发布说明三者一致且符合 windows-unsigned 契约，否则抛 ReleaseInputError。 */
export function assertReleaseInput(params: {
  inputVersion: string
  packageVersion: string
  notesText: string
}): ReleaseNotes

export interface CiRunSummary {
  headSha?: string
  status?: string
  conclusion?: string | null
}

/** 该提交已有成功 CI 时返回 ok:true，否则给出不可发布的原因。 */
export function ciConclusion(
  runs: CiRunSummary[],
  headSha: string
): { ok: true; run: CiRunSummary } | { ok: false; reason: string }

export const CI_WORKFLOW: string
