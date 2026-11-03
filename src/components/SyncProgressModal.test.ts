// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Platform } from 'obsidian'
import type NutstorePlugin from '~/index'
import i18n from '~/i18n'
import {
	emitSyncUpdateMtimeProgress,
	type SyncPreparationProgress,
} from '~/events'
import type { SyncRunSnapshot } from '~/services/progress.service'
import SyncProgressModal from './SyncProgressModal'

const { notice } = vi.hoisted(() => ({ notice: vi.fn() }))

vi.mock('obsidian', () => {
	function element(
		tag = 'div',
		options: {
			cls?: string
			text?: string
			attr?: Record<string, string>
		} = {},
	) {
		const el = document.createElement(tag)
		el.className = options.cls ?? ''
		el.textContent = options.text ?? ''
		Object.entries(options.attr ?? {}).forEach(([key, value]) =>
			el.setAttribute(key, value),
		)
		return Object.assign(el, {
			createDiv: (opts?: typeof options) =>
				el.appendChild(element('div', opts)),
			createSpan: (opts?: typeof options) =>
				el.appendChild(element('span', opts)),
			empty: () => el.replaceChildren(),
			setText: (text: string) => {
				el.textContent = text
			},
			addClass: (cls: string) => el.classList.add(...cls.split(/\s+/)),
			removeClass: (cls: string) => el.classList.remove(...cls.split(/\s+/)),
			show: () => {
				el.style.removeProperty('display')
			},
			hide: () => {
				el.style.setProperty('display', 'none')
			},
			toggle: (show: boolean) => {
				el.style.setProperty('display', show ? '' : 'none')
			},
			setCssProps: (props: Record<string, string>) =>
				Object.entries(props).forEach(([key, value]) =>
					el.style.setProperty(key, value),
				),
		})
	}
	return {
		Platform: { isMobile: false },
		Notice: class {
			constructor(message: string, duration: number) {
				notice(message, duration)
			}
		},
		Modal: class {
			modalEl = element('div', { cls: 'modal' })
			titleEl = this.modalEl
				.createDiv({ cls: 'modal-header' })
				.createDiv({ cls: 'modal-title' })
			contentEl = this.modalEl.createDiv({ cls: 'modal-content' })
		},
		ButtonComponent: class {
			buttonEl: HTMLElement
			constructor(parent: HTMLElement) {
				this.buttonEl = parent.appendChild(element('button'))
			}
			setButtonText(text: string) {
				this.buttonEl.textContent = text
				return this
			}
			setDisabled(disabled: boolean) {
				this.buttonEl.toggleAttribute('disabled', disabled)
				return this
			}
			onClick(callback: () => void) {
				this.buttonEl.addEventListener('click', callback)
				return this
			}
		},
		setIcon: (el: HTMLElement, icon: string) => {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
			svg.setAttribute('data-icon', icon)
			el.replaceChildren(svg)
		},
		TFile: class {},
		normalizePath: (path: string) => path,
	}
})

const path = '/notes/示例🌿/chapter & <draft>'
const scanning = (processed = 2, queued = 3): SyncPreparationProgress => ({
	phase: 'traversingRemote',
	traversal: {
		phase: 'scanning',
		currentPath: path,
		processedDirectories: processed,
		queuedDirectories: queued,
		discoveredItems: 8,
		processedChanges: 0,
	},
})
const modals: SyncProgressModal[] = []
afterEach(async () => {
	notice.mockClear()
	modals.splice(0).forEach((modal) => modal.onClose())
	vi.mocked(Platform).isMobile = false
	await i18n.changeLanguage('en')
})

const runOf = (patch: Partial<SyncRunSnapshot> = {}): SyncRunSnapshot => ({
	status: 'syncing',
	startedAt: 0,
	preparation: null,
	total: 0,
	completed: [],
	current: null,
	currentInFlight: false,
	failedCount: 0,
	scanIssues: [],
	...patch,
})

function mount(preparation: SyncPreparationProgress = scanning()) {
	const progress: { run: SyncRunSnapshot } = {
		run: runOf({ status: 'preparing', preparation }),
	}
	/** The service replaces the snapshot on every change; do the same here. */
	const set = (patch: Partial<SyncRunSnapshot>) => {
		progress.run = { ...progress.run, ...patch }
	}
	const settings = { skipLargeFiles: { maxSize: '' } }
	const showScanIssues = vi.fn()
	const modal = new SyncProgressModal({
		app: {},
		settings,
		sync: { progress, events: { showScanIssues } },
	} as unknown as NutstorePlugin)
	modals.push(modal)
	modal.onOpen()
	const find = (cls: string) =>
		modal.modalEl.querySelector<HTMLElement>(`.nutstore-sync-progress__${cls}`)!
	return {
		modal,
		progress,
		set,
		settings,
		showScanIssues,
		find,
		bar: find('primary').querySelector<HTMLElement>(
			'.nutstore-sync-progress__bar',
		)!,
		track: find('primary').querySelector<HTMLElement>('[role="progressbar"]')!,
	}
}

describe('sync progress modal', () => {
	it.each(['zh', 'en'])(
		'shows mobile upload advice only for a sync with large uploads in %s',
		async (language) => {
			await i18n.changeLanguage(language)
			const { modal, set, find, settings } = mount()
			const hint = find('large-upload-hint')
			expect(hint.style.display).toBe('none')
			set({ status: 'syncing', preparation: null, hasLargeUploads: true })
			modal.update()
			expect(hint.style.display).toBe('none')
			vi.mocked(Platform).isMobile = true
			modal.update()
			expect(hint.style.display).toBe('')
			expect(hint.textContent).toContain(i18n.t('settings.skipLargeFiles.name'))
			expect(hint.textContent).toContain('20 MB')
			expect(hint.textContent).toContain('40 MB')
			for (const maxSize of ['30 MB', '100 MB']) {
				settings.skipLargeFiles.maxSize = maxSize
				modal.update()
				expect(hint.style.display).toBe('none')
			}
			settings.skipLargeFiles.maxSize = '  '
			modal.update()
			expect(hint.style.display).toBe('')
			set({ current: null })
			modal.update()
			expect(hint.style.display).toBe('')
			set({ hasLargeUploads: false })
			modal.update()
			expect(hint.style.display).toBe('none')
		},
	)

	it.each([
		{
			language: 'zh',
			label: '扫描进度',
			stats: ['已扫描目录', '待扫描目录', '已发现项目'],
		},
		{
			language: 'en',
			label: 'Scan progress',
			stats: ['Directories scanned', 'Directories queued', 'Items found'],
		},
	])(
		'shows real scan work and preserves a multilingual path in $language',
		async ({ language, label, stats }) => {
			await i18n.changeLanguage(language)
			const { find, bar, track } = mount()
			expect(find('label').textContent).toBe(label)
			expect(find('bar-label').textContent).toBe('2 / 5')
			expect(bar.style.width).toBe('40%')
			expect(track.hasAttribute('aria-valuenow')).toBe(false)
			expect(find('current-file').textContent).toBe(path)
			expect(find('current-file').title).toBe(path)
			expect(find('current-file').childElementCount).toBe(0)
			expect(
				Array.from(
					find('stats').querySelectorAll('.nutstore-sync-progress__stat-label'),
				).map((el) => el.textContent),
			).toEqual(stats)
			expect(
				Array.from(
					find('stats').querySelectorAll('.nutstore-sync-progress__stat-count'),
				).map((el) => el.textContent),
			).toEqual(['2', '3', '8'])
		},
	)

	it('recalculates known work when scanning discovers more directories without restarting the icon', () => {
		const { modal, set, find, bar } = mount(scanning(2, 2))
		const icon = modal.titleEl.querySelector('svg')
		expect(bar.style.width).toBe('50%')
		set({ preparation: scanning(3, 9) })
		modal.update()
		expect(bar.style.width).toBe('25%')
		expect(find('bar-label').textContent).toBe('3 / 12')
		expect(modal.titleEl.querySelector('svg')).toBe(icon)
	})

	it('keeps unknown preparation work visible without inventing a total', () => {
		const { bar, find, track } = mount({ phase: 'checkingRemote' })
		expect(bar.style.width).toBe('40%')
		expect(bar.classList.contains('nutstore-sync-progress-indeterminate')).toBe(
			true,
		)
		expect(find('stats').style.display).toBe('none')
		expect(track.hasAttribute('aria-valuenow')).toBe(false)
	})

	it('retains scan counts while waiting for a retry and restores scanning afterward', () => {
		const { modal, set, bar, find } = mount()
		set({
			preparation: {
				...scanning(),
				traversal: { ...scanning().traversal!, phase: 'retrying' },
			},
		})
		modal.update()
		expect(modal.modalEl.dataset.preparationPhase).toBe('retrying')
		expect(find('bar-label').textContent).toBe('2 / 5')
		expect(bar.style.width).toBe('40%')
		set({ preparation: scanning(3, 2) })
		modal.update()
		expect(modal.modalEl.dataset.preparationPhase).toBe('scanning')
		expect(bar.style.width).toBe('60%')
	})

	it('uses an activity bar for incremental changes whose total is unknown', () => {
		const preparation = scanning()
		Object.assign(preparation.traversal!, {
			phase: 'incremental',
			processedChanges: 4,
		})
		const { find, bar } = mount(preparation)
		expect(find('summary').textContent).toBe('Processed 4 remote changes')
		expect(find('stats').style.display).toBe('none')
		expect(bar.classList.contains('nutstore-sync-progress-indeterminate')).toBe(
			true,
		)
	})

	it('switches from scanning to task progress and shows an empty successful sync as complete', () => {
		const { modal, set, find, track, bar } = mount()
		set({ status: 'syncing', preparation: null })
		modal.update()
		expect(find('label').textContent).toBe('Sync progress')
		expect(find('stats').style.display).toBe('none')
		expect(find('hint').style.display).toBe('none')
		expect(track.getAttribute('aria-valuenow')).toBe('0')
		expect(bar.classList.contains('nutstore-sync-progress-indeterminate')).toBe(
			false,
		)
		set({ status: 'complete' })
		modal.update()
		expect(modal.modalEl.dataset.state).toBe('complete')
		expect(bar.style.width).toBe('100%')
		expect(find('files').style.display).toBe('none')
	})

	it.each(['zh', 'en'])(
		'shows unavailable Unicode paths as a warning and clears them on the next run in %s',
		async (language) => {
			await i18n.changeLanguage(language)
			const { modal, progress, set, find, showScanIssues } = mount()
			const scanIssues = [
				{
					path: 'Notes 笔记🌱/Section & <draft>📘',
					operation: 'list' as const,
					cause: new Error('Unavailable 暂不可用🌿'),
				},
			]
			set({ status: 'warning', preparation: null, scanIssues })
			modal.update()
			expect(modal.modalEl.dataset.state).toBe('warning')
			expect(modal.titleEl.textContent).toBe(i18n.t('sync.partialScanTitle'))
			expect(modal.titleEl.textContent).not.toContain('1')
			expect(modal.contentEl.textContent).toContain(
				i18n.t('scanIssues.summary', { count: 1 }),
			)
			expect(modal.titleEl.querySelector('draft')).toBeNull()
			const view = find('scan-issues').querySelector('button')!
			expect(view.textContent).toBe(i18n.t('scanIssues.view'))
			view.click()
			expect(showScanIssues).toHaveBeenCalledWith(progress.run.scanIssues)
			expect(find('scan-issues').style.display).not.toBe('none')
			expect(
				find('footer').querySelector('button')?.classList.contains('hidden'),
			).toBe(true)
			set({ status: 'preparing', scanIssues: [], preparation: scanning() })
			modal.update()
			expect(modal.modalEl.dataset.state).toBe('preparing')
			expect(find('scan-issues').style.display).toBe('none')
			expect(modal.titleEl.textContent).not.toContain('Section & <draft>📘')
		},
	)

	it.each(['zh', 'en'])(
		'lists each finished task with its failure reason and no task in flight in %s',
		async (language) => {
			await i18n.changeLanguage(language)
			const { modal, set, find } = mount()
			const ref = (localPath: string) => ({
				kind: 'upload' as const,
				localPath,
			})
			set({
				status: 'warning',
				preparation: null,
				total: 2,
				failedCount: 1,
				completed: [
					{ ...ref('笔记🌱/<a> & b.md'), success: true },
					{
						...ref('Notes/章节 📘.md'),
						success: false,
						error: '无法连接 <offline>',
					},
				],
				current: ref('Notes/章节 📘.md'),
				currentInFlight: false,
			})
			modal.update()
			const rows = Array.from(
				find('files-list').querySelectorAll<HTMLElement>(':scope > div'),
			)
			expect(rows).toHaveLength(2)
			expect(rows[0].textContent).toContain('Notes/章节 📘.md')
			expect(rows[0].textContent).toContain('无法连接 <offline>')
			expect(rows[0].querySelector('offline')).toBeNull()
			expect(rows[1].textContent).toContain('笔记🌱/<a> & b.md')
			expect(rows[1].textContent).not.toContain('无法连接')
			expect(find('current-file').textContent).toBe('')
			expect(modal.titleEl.textContent).toBe(
				i18n.t('sync.completeWithFailed', { failedCount: 1 }),
			)
		},
	)

	it.each(['zh', 'en'])(
		'explains why a run failed and offers only closing in %s',
		async (language) => {
			await i18n.changeLanguage(language)
			const { modal, set, find } = mount()
			set({
				status: 'error',
				preparation: null,
				error: new Error('远端不可用 🌿 <503>'),
			})
			modal.update()
			expect(modal.modalEl.dataset.state).toBe('error')
			expect(modal.titleEl.textContent).toBe(i18n.t('sync.failedStatus'))
			expect(find('summary').textContent).toBe('远端不可用 🌿 <503>')
			expect(find('summary').style.display).not.toBe('none')
			expect(find('status').style.display).not.toBe('none')
			expect(
				find('footer').querySelector('button')?.classList.contains('hidden'),
			).toBe(true)
			set({ status: 'syncing', error: undefined })
			modal.update()
			expect(find('summary').style.display).toBe('none')
		},
	)

	it.each(['zh', 'en'])(
		'keeps cancellation pending until the request settles in %s',
		async (language) => {
			await i18n.changeLanguage(language)
			const { modal, set, find } = mount()
			set({ status: 'cancelling' })
			modal.update()
			expect(modal.modalEl.dataset.state).toBe('cancelling')
			expect(modal.titleEl.textContent).toBe(i18n.t('sync.syncingFiles'))
			expect(find('footer').querySelector('button')?.textContent).toBe(
				i18n.t('sync.cancelling'),
			)
			expect(find('summary').style.display).toBe('none')
			const stopButton = find('footer').querySelector('button')!
			expect(stopButton.disabled).toBe(false)
			expect(notice).not.toHaveBeenCalled()
			stopButton.click()
			stopButton.click()
			expect(notice).toHaveBeenCalledTimes(2)
			expect(notice).toHaveBeenNthCalledWith(
				1,
				i18n.t('sync.cancellingHint'),
				3000,
			)
			expect(notice).toHaveBeenNthCalledWith(
				2,
				i18n.t('sync.cancellingHint'),
				3000,
			)
			set({ status: 'cancelled', preparation: null })
			modal.update()
			expect(modal.modalEl.dataset.state).toBe('cancelled')
			expect(modal.titleEl.textContent).toBe(i18n.t('sync.cancelled'))
		},
	)

	it('renders cache progress beside its label and clears it for preparation', () => {
		const { modal, set, find } = mount()
		set({ status: 'syncing', preparation: null })
		modal.update()
		emitSyncUpdateMtimeProgress(4, 2)
		expect(
			find('cache').querySelector('.nutstore-sync-progress__meta')?.textContent,
		).toBe('Cache update progress50%')
		set({ status: 'preparing', preparation: scanning() })
		modal.update()
		expect(find('cache').style.display).toBe('none')
	})
})
