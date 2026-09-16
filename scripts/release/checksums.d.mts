/**
 * `scripts/release/checksums.mjs` 的类型声明(发布脚本用 .mjs,供单测/演练导入)。
 * T14 门禁债修正:tests/upgrade/release-metadata.test.ts 动态导入该模块时,
 * e2e 工程(`noImplicitAny`)要求显式声明,否则 TS7016。
 */

export interface ChecksumArtifact {
  /** 文件名(不含目录) */
  name: string
  /** 字节数 */
  size: number
}

/** 计算 SHA-256(hex) */
export declare function sha256Of(path: string): Promise<string>

/**
 * 收集 `dist/` 下应当出现在校验和清单里的文件(按文件名排序,保证可复现):
 * 排除点文件、`*.blockmap`、builder 调试输出与清单自身。
 */
export declare function collectArtifacts(distDir: string): Promise<ChecksumArtifact[]>
