import { describe, expect, it, vi } from 'vitest'
import { listMemoryEntries } from '~/ai/memory/memory-note'
import {
	fencedCode,
	formatDuration,
	formatSystemNotificationMarkdown,
	formatTime,
	formatToolDetailsMarkdown,
	shouldSubmitChatInput,
	toolCallDisplayTitle,
	toolCallPurpose,
} from './utils'

describe('shouldSubmitChatInput', () => {
	const enterEvent = {
		key: 'Enter',
		shiftKey: false,
		isComposing: false,
		keyCode: 13,
	}

	it('submits a plain Enter key', () => {
		expect(shouldSubmitChatInput(enterEvent, false)).toBe(true)
	})

	it('does not submit while an IME composition is being confirmed', () => {
		expect(shouldSubmitChatInput({ ...enterEvent, keyCode: 229 }, false)).toBe(
			false,
		)
		expect(
			shouldSubmitChatInput({ ...enterEvent, isComposing: true }, false),
		).toBe(false)
		expect(shouldSubmitChatInput(enterEvent, true)).toBe(false)
	})
})

describe('formatTime', () => {
	it('falls back without Intl', () => {
		vi.stubGlobal('Intl', undefined)
		try {
			const timestamp = new Date(2024, 1, 29, 9, 7).getTime()
			expect(formatTime(timestamp)).toBe('02/29 09:07')
		} finally {
			vi.unstubAllGlobals()
		}
	})
})

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
			kind: 'task-result-ready',
			taskId: '状态更新 / Status update 🌿',
			resultPath: '/result.txt',
		})

		expect(markdown).toContain('```json')
		expect(markdown).toContain('"taskId": "状态更新 / Status update 🌿"')
	})

	it('omits the params section when params are hidden', () => {
		const markdown = formatToolDetailsMarkdown(
			undefined,
			'处理完成 / Completed',
		)

		expect(markdown).not.toContain('params')
		expect(markdown).not.toContain('```json')
		expect(markdown).toContain('```text\n处理完成 / Completed\n```')
	})
})

describe('toolCallPurpose', () => {
	function makeToolCall(input: unknown) {
		return { toolName: 'bash', input } as unknown as Parameters<
			typeof toolCallPurpose
		>[0]
	}

	it('returns the trimmed plain-language purpose when present', () => {
		expect(
			toolCallPurpose(makeToolCall({ purpose: '  读取备注 / Read note  ' })),
		).toBe('读取备注 / Read note')
	})

	it('returns undefined when purpose is blank, missing, or not a string', () => {
		for (const input of [
			undefined,
			null,
			'string',
			{ purpose: '' },
			{ purpose: '   ' },
			{ purpose: 42 },
			{},
		]) {
			expect(toolCallPurpose(makeToolCall(input))).toBeUndefined()
		}
	})
})

describe('toolCallDisplayTitle', () => {
	function makeToolCall(input: unknown, toolName = 'bash') {
		return { toolName, input } as unknown as Parameters<
			typeof toolCallDisplayTitle
		>[0]
	}

	it('prefers a non-empty plain-language purpose over the tool name', () => {
		const title = toolCallDisplayTitle(
			makeToolCall({ purpose: '读取备注内容 / Read the note content' }),
		)
		expect(title).toBe('读取备注内容 / Read the note content')
	})

	it('uses purpose as the title for apply_patch calls', () => {
		expect(
			toolCallDisplayTitle(
				makeToolCall(
					{ purpose: '  修复同步冲突 🚀 / Repair sync conflict  ' },
					'apply_patch',
				),
			),
		).toBe('修复同步冲突 🚀 / Repair sync conflict')
	})

	it('falls back to the tool name when purpose is blank or whitespace', () => {
		for (const purpose of ['', '   ']) {
			expect(toolCallDisplayTitle(makeToolCall({ purpose }))).toBe('bash')
		}
	})

	it('falls back to the tool name when purpose is missing or not a string', () => {
		for (const input of [undefined, null, 'string', { purpose: 42 }, {}]) {
			expect(toolCallDisplayTitle(makeToolCall(input))).toBe('bash')
		}
	})

	it('titles memory calls with the entries they remember and forget', () => {
		const id = listMemoryEntries('Old preference 旧偏好 📦')[0].id
		const title = toolCallDisplayTitle(
			makeToolCall(
				{ remember: ['Prefers metric 偏好公制 📏'], forget: [id, 7] },
				'memory',
			),
		)
		expect(title).toContain('Prefers metric 偏好公制 📏')
		expect(title).toContain(id)
		expect(toolCallDisplayTitle(makeToolCall({}, 'memory'))).toBe('memory')
	})

	it('shows resolved deleted text instead of IDs after a memory edit succeeds', () => {
		const text = 'Old preference 旧偏好 📦'
		const id = listMemoryEntries(text)[0].id
		const title = toolCallDisplayTitle({
			type: 'dynamic-tool',
			toolCallId: 'memory-delete',
			toolName: 'memory',
			input: { forget: [id] },
			state: 'output-available',
			output: { forgotten: [text] },
		})
		expect(title).toContain(text)
		expect(title).not.toContain(id)
	})
})
