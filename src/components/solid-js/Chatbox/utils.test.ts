import { describe, expect, it } from 'vitest'
import {
	fencedCode,
	formatDuration,
	formatSystemNotificationMarkdown,
	formatToolDetailsMarkdown,
} from './utils'

describe('formatDuration', () => {
	it('uses compact stable units', () => {
		expect(formatDuration(320)).toBe('320ms')
		expect(formatDuration(8_900)).toBe('8s')
		expect(formatDuration(68_000)).toBe('1m 08s')
		expect(formatDuration(3_720_000)).toBe('1h 02m')
	})
})

describe('chat detail markdown', () => {
	it('formats bilingual parameters and text results as fenced code', () => {
		const markdown = formatToolDetailsMarkdown(
			{ title: '中性标题 / Neutral title' },
			'处理完成 / Completed',
		)

		expect(markdown).toContain('```json')
		expect(markdown).toContain('"title": "中性标题 / Neutral title"')
		expect(markdown).toContain('```text\n处理完成 / Completed\n```')
	})

	it('uses a safe fence for bilingual content containing backticks', () => {
		const markdown = fencedCode(
			'text',
			'中性示例 / Neutral example: ```sample```',
		)

		expect(markdown).toBe(
			'````text\n中性示例 / Neutral example: ```sample```\n````',
		)
	})

	it('formats bilingual system notification data as JSON', () => {
		const markdown = formatSystemNotificationMarkdown({
			message: '状态更新 / Status update',
		})

		expect(markdown).toContain('```json')
		expect(markdown).toContain('"message": "状态更新 / Status update"')
	})
})
