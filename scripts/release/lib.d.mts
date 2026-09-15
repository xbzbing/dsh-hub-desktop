/** `lib.mjs` 的类型声明(单测与脚本共用,与 gateway-fixture.d.mts 同一约定) */

export interface UpdateFileEntry {
  url: string
  sha512: string
  size: number | null
}

export interface UpdateMetadata {
  version: string
  files: UpdateFileEntry[]
  path: string
  sha512: string
  releaseDate: string | null
}

export interface ArtifactHash {
  name: string
  sha512: string
  size: number
}

export interface ReleaseNotes {
  version: string
  date: string
  artifacts: string[]
}

export class UpdateMetadataError extends Error {}

export function normalizeArtifactUrl(url: string): string
export function parseUpdateYaml(text: string): UpdateMetadata
export function verifyUpdateMetadata(input: {
  metadata: UpdateMetadata
  appVersion: string
  artifacts: ArtifactHash[]
}): { ok: boolean; problems: string[] }
export function parseReleaseNotes(markdown: string): ReleaseNotes
export const PLACEHOLDER_MARKERS: string[]
export function findPlaceholders(markdown: string): string[]
