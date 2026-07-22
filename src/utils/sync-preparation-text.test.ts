import { afterAll, describe, expect, it } from 'vitest'
import i18n from '~/i18n'
import { getSyncPreparationText } from './sync-preparation-text'

describe('getSyncPreparationText', () => {
	afterAll(async () => {
		await i18n.changeLanguage('en')
	})

	it.each([
		{
			language: 'zh',
			operation: '正在扫描远端目录…',
			detail: '已扫描 2 个目录，待扫描 3 个目录，已发现 5 个项目',
		},
		{
			language: 'en',
			operation: 'Scanning remote directories…',
			detail: 'Scanned 2 directories, 3 queued, 5 items found',
		},
	])('formats neutral traversal progress in $language', async (expected) => {
		await i18n.changeLanguage(expected.language)

		const result = getSyncPreparationText({
			phase: 'traversingRemote',
			traversal: {
				phase: 'scanning',
				currentPath: '/notes',
				processedDirectories: 2,
				queuedDirectories: 3,
				discoveredItems: 5,
				processedChanges: 0,
			},
		})

		expect(result).toEqual({
			operation: expected.operation,
			detail: expected.detail,
		})
	})

	it.each([
		{ language: 'zh', expected: '已处理 8 项远端变化' },
		{ language: 'en', expected: 'Processed 8 remote changes' },
	])('formats neutral incremental progress in $language', async (testCase) => {
		await i18n.changeLanguage(testCase.language)

		const result = getSyncPreparationText({
			phase: 'traversingRemote',
			traversal: {
				phase: 'incremental',
				processedDirectories: 4,
				queuedDirectories: 0,
				discoveredItems: 12,
				processedChanges: 8,
			},
		})

		expect(result.detail).toBe(testCase.expected)
	})
})
