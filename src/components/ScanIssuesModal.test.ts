// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '~/i18n'
import type { ScanIssue } from '~/sync/scope'
import ScanIssuesModal, { describeScanCause } from './ScanIssuesModal'

const { notice, lists } = vi.hoisted(() => ({
	notice: vi.fn(),
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

vi.mock('obsidian', () => {
	function element(tag = 'div', options: { cls?: string; text?: string } = {}) {
		const el = document.createElement(tag)
		el.className = options.cls ?? ''
		el.textContent = options.text ?? ''
		return Object.assign(el, {
			createDiv: (opts?: typeof options) =>
				el.appendChild(element('div', opts)),
			createEl: (t: string, opts?: typeof options) =>
				el.appendChild(element(t, opts)),
			createSpan: (opts?: typeof options) =>
				el.appendChild(element('span', opts)),
			empty: () => el.replaceChildren(),
		})
	}
	return {
		Notice: class {
			constructor(message: string) {
				notice(message)
			}
		},
		Modal: class {
			modalEl = element('div', { cls: 'modal' })
			titleEl = element('div')
			contentEl = this.modalEl.createDiv({ cls: 'modal-content' })
			setTitle(title: string) {
				this.titleEl.textContent = title
			}
			open() {
				this.onOpen()
			}
			close() {
				this.onClose()
			}
			onOpen() {}
			onClose() {}
		},
		Setting: class {
			private readonly el: HTMLElement
			constructor(parent: HTMLElement) {
				this.el = parent.appendChild(document.createElement('div'))
			}
			setClass(cls: string) {
				this.el.classList.add(cls)
				return this
			}
			addButton(
				cb: (button: {
					setButtonText(t: string): unknown
					setCta(): unknown
					onClick(fn: () => void): unknown
				}) => void,
			) {
				const el = this.el.appendChild(document.createElement('button'))
				const button = {
					setButtonText: (t: string) => ((el.textContent = t), button),
					setCta: () => button,
					onClick: (fn: () => void) => (
						el.addEventListener('click', fn),
						button
					),
				}
				cb(button)
				return this
			}
		},
	}
})

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
	notice.mockClear()
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

	describe('with thousands of issues', () => {
		const many: ScanIssue[] = Array.from({ length: 10_000 }, (_, index) => ({
			path: `目录 Folder ${String(index).padStart(5, '0')}🌱/子目录`,
			operation: 'list',
			cause: new Error('Unavailable 暂不可用🌿'),
		}))

		it('passes all of them to the windowed list', () => {
			const modal = new ScanIssuesModal({} as never, [...many].reverse())
			modal.open()
			expect(current().items).toHaveLength(10_000)
			expect(current().items[0].path).toBe('目录 Folder 00000🌱/子目录')
			expect(current().items.at(-1)!.path).toBe('目录 Folder 09999🌱/子目录')
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
			await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
			const text = (writeText.mock.calls[0] as unknown as [string])[0]
			expect(text.split('\n')).toHaveLength(10_000)
			expect(text.split('\n')[9_999]).toBe(
				`目录 Folder 09999🌱/子目录\t${i18n.t('scanIssues.operations.list')}\tUnavailable 暂不可用🌿`,
			)
			expect(notice).toHaveBeenCalledWith(
				i18n.t('scanIssues.copied', { count: 10_000 }),
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
			await vi.waitFor(() =>
				expect(notice).toHaveBeenCalledWith(i18n.t('scanIssues.copyFailed')),
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
