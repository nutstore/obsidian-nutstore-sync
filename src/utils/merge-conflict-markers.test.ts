import { describe, expect, it } from 'vitest'
import { countMergeConflictBlocks } from './merge-conflict-markers'

describe('countMergeConflictBlocks', () => {
	it('counts complete conflict blocks in English content', () => {
		const content = [
			'# Shared notes',
			'<<<<<<< local',
			'Keep the first neutral detail.',
			'=======',
			'Keep the second neutral detail.',
			'>>>>>>> remote',
			'',
			'<<<<<<< local',
			'Current wording.',
			'||||||| base',
			'Original wording.',
			'=======',
			'Incoming wording.',
			'>>>>>>> remote',
		].join('\n')

		expect(countMergeConflictBlocks(content)).toBe(2)
	})

	it('counts complete conflict blocks in Chinese content', () => {
		const content = [
			'# 共享笔记',
			'<<<<<<< 本地版本',
			'保留第一条中性内容。',
			'=======',
			'保留第二条中性内容。',
			'>>>>>>> 远端版本',
		].join('\n')

		expect(countMergeConflictBlocks(content)).toBe(1)
	})

	it('ignores marker-like text without a complete block', () => {
		const content = [
			'<<<<<<< example',
			'This is neutral sample text.',
			'The separator and end marker are absent.',
		].join('\n')

		expect(countMergeConflictBlocks(content)).toBe(0)
	})

	it('does not count a block without a separator', () => {
		const content = [
			'<<<<<<< 示例',
			'这是一段中性示例内容。',
			'>>>>>>> 示例',
		].join('\n')

		expect(countMergeConflictBlocks(content)).toBe(0)
	})
})
