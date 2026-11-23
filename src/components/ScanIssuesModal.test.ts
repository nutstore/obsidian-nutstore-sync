// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushUntil } from '@test/harness/async-scheduler'
import { obsidianRuntime } from '@test/obsidian-runtime'
import i18n from '~/i18n'
import type { ScanIssue } from '~/sync/scope'
import ScanIssuesModal, { describeScanCause } from './ScanIssuesModal'

const { lists } = vi.hoisted(() => ({
	lists: [] as {
		items: { path: string; step: string; cause: string }[]
		destroyed: boolean
	}[],
}))

vi.mock('./solid-js', () => ({
	mountScanIssueList: (
		_el: Element,
		props: { items: { path: string; step: string; cause: string }[] },
	) => {
		const list = { items: props.items, destroyed: false }
		lists.push(list)
		return {
			update: (next: typeof props) => {
				list.items = next.items
			},
			destroy: () => {
				list.destroyed = true
			},
		}
	},
}))

const issues: ScanIssue[] = [
	{
		path: 'Notes 笔记🌱/Section & <draft>',
		operation: 'list',
		cause: new Error('Unavailable 暂不可用🌿'),
	},
	{ path: 'Archive/資料.md', operation: 'stat', cause: 'plain failure 失败' },
]

const current = () => lists.at(-1)!
const rows = () =>
	current().items.map((item) => [item.path, item.step, item.cause])

afterEach(async () => {
	obsidianRuntime.reset()
	lists.length = 0
	await i18n.changeLanguage('en')
})

describe('ScanIssuesModal', () => {
	it.each(['en', 'zh'])(
		'hands every path, step and cause to the list in %s',
		async (language) => {
			await i18n.changeLanguage(language)
			const modal = new ScanIssuesModal({} as never, issues)
			modal.open()
			expect(modal.modalEl.classList.contains('mod-lg')).toBe(true)
			expect(modal.titleEl.textContent).toBe(i18n.t('scanIssues.title'))
			// Rows are ordered by path so the list is predictable.
			expect(rows()).toEqual([
				[
					'Archive/資料.md',
					i18n.t('scanIssues.operations.stat'),
					'plain failure 失败',
				],
				[
					'Notes 笔记🌱/Section & <draft>',
					i18n.t('scanIssues.operations.list'),
					'Unavailable 暂不可用🌿',
				],
			])
			expect(modal.contentEl.textContent).toContain(
				i18n.t('scanIssues.instruction', { count: 2 }),
			)
			modal.close()
			expect(current().destroyed).toBe(true)
			expect(modal.modalEl.classList.contains('mod-lg')).toBe(false)
		},
	)

	it('refreshes the open list and count when a later sync ends', () => {
		const modal = new ScanIssuesModal({} as never, issues)
		modal.open()
		modal.update([issues[1]])
		expect(rows()).toHaveLength(1)
		expect(lists).toHaveLength(1)
		expect(modal.contentEl.textContent).toContain(
			i18n.t('scanIssues.instruction', { count: 1 }),
		)
	})

	describe('with many issues', () => {
		const count = 200
		const many: ScanIssue[] = Array.from({ length: count }, (_, index) => ({
			path: `目录 Folder ${String(index).padStart(5, '0')}🌱/子目录`,
			operation: 'list',
			cause: new Error('Unavailable 暂不可用🌿'),
		}))

		it('passes all of them sorted to the windowed list', () => {
			const modal = new ScanIssuesModal({} as never, [...many].reverse())
			modal.open()
			expect(current().items).toHaveLength(count)
			expect(current().items[0].path).toBe('目录 Folder 00000🌱/子目录')
			expect(current().items.at(-1)!.path).toBe(
				`目录 Folder ${String(count - 1).padStart(5, '0')}🌱/子目录`,
			)
		})

		it('copies every path', async () => {
			const writeText = vi.fn(async () => {})
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText },
				configurable: true,
			})
			const modal = new ScanIssuesModal({} as never, many)
			modal.open()
			modal.contentEl
				.querySelector<HTMLButtonElement>('.scan-issues-actions button')!
				.click()
			await flushUntil(() => expect(writeText).toHaveBeenCalledOnce())
			const text = (writeText.mock.calls[0] as unknown as [string])[0]
			expect(text.split('\n')).toHaveLength(count)
			expect(text.split('\n')[count - 1]).toBe(
				`目录 Folder ${String(count - 1).padStart(5, '0')}🌱/子目录\t${i18n.t('scanIssues.operations.list')}\tUnavailable 暂不可用🌿`,
			)
			expect(obsidianRuntime.notices.at(-1)?.message).toBe(
				i18n.t('scanIssues.copied', { count }),
			)
		})

		it('reports a clipboard failure instead of throwing', async () => {
			Object.defineProperty(navigator, 'clipboard', {
				value: {
					writeText: vi.fn(async () => Promise.reject(new Error('denied'))),
				},
				configurable: true,
			})
			const modal = new ScanIssuesModal({} as never, issues)
			modal.open()
			modal.contentEl
				.querySelector<HTMLButtonElement>('.scan-issues-actions button')!
				.click()
			await flushUntil(() =>
				expect(obsidianRuntime.notices.at(-1)?.message).toBe(
					i18n.t('scanIssues.copyFailed'),
				),
			)
		})
	})
})

describe('describeScanCause', () => {
	it.each([
		[
			"EACCES: permission denied, scandir '/base 库/Notes 笔记🌱/Section'",
			'Notes 笔记🌱/Section',
			'EACCES: permission denied, scandir',
		],
		['Unavailable 暂不可用🌿', 'Notes', 'Unavailable 暂不可用🌿'],
		[
			'Listed entry has no metadata: Notes/資料.md',
			'Notes/資料.md',
			'Listed entry has no metadata',
		],
		['Notes/資料.md', 'Notes/資料.md', 'Notes/資料.md'],
	])(
		'drops the path already shown in the row: %s',
		(message, path, expected) => {
			expect(
				describeScanCause({
					path,
					operation: 'list',
					cause: new Error(message),
				}),
			).toBe(expected)
		},
	)
})
