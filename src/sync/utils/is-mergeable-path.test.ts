import { describe, expect, it } from 'vitest'
import { isMergeablePath } from './is-mergeable-path'

describe('isMergeablePath', () => {
	it.each([
		'notes/example.md',
		'文档/示例.txt',
		'settings/example.json',
		'config/example.yaml',
		'config/example.toml',
		'source/example.ts',
		'README',
	])('识别文本文件 %s', (path) => {
		expect(isMergeablePath(path)).toBe(true)
	})

	it.each(['assets/example.png', 'archive/example.zip', 'data/example.bin'])(
		'拒绝二进制文件 %s',
		(path) => {
			expect(isMergeablePath(path)).toBe(false)
		},
	)
})
