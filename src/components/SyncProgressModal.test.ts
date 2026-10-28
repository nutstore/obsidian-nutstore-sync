// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Platform } from 'obsidian'
import type NutstorePlugin from '~/index'
import i18n from '~/i18n'
import {
	emitCancelSync,
	emitPreparingSync,
	emitSyncProgress,
	emitSyncCancelled,
	emitSyncUpdateMtimeProgress,
	type SyncPreparationProgress,
} from '~/events'
import { ProgressService } from '~/services/progress.service'
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

function mount(preparation: SyncPreparationProgress = scanning()) {
	const progress: Pick<
		ProgressService,
		| 'syncProgress'
		| 'preparationProgress'
		| 'syncFailedCount'
		| 'syncFailed'
		| 'syncEnd'
		| 'cancellationState'
	> = {
		syncProgress: { total: 0, completed: [], current: null },
		preparationProgress: preparation,
		syncFailedCount: 0,
		syncFailed: false,
		syncEnd: false,
		cancellationState: 'none',
	}
	const modal = new SyncProgressModal({
		app: {},
		sync: { progress },
	} as unknown as NutstorePlugin)
	modals.push(modal)
	modal.onOpen()
	const find = (cls: string) =>
		modal.modalEl.querySelector<HTMLElement>(`.nutstore-sync-progress__${cls}`)!
	return {
		modal,
		progress,
		find,
		bar: find('primary').querySelector<HTMLElement>(
			'.nutstore-sync-progress__bar',
		)!,
		track: find('primary').querySelector<HTMLElement>('[role="progressbar"]')!,
	}
}

describe('sync progress modal', () => {
	it('retains the stop request across modal lifetimes and waits for cancellation acknowledgement', () => {
		const plugin = {
			sync: { executor: { isRunning: () => true } },
		} as unknown as NutstorePlugin
		const service = new ProgressService(plugin)
		service.onload()
		try {
			emitCancelSync()
			expect(service.cancellationState).toBe('requested')
			emitCancelSync()
			expect(notice).not.toHaveBeenCalled()
			emitSyncCancelled()
			expect(service.cancellationState).toBe('complete')
			emitPreparingSync({ showNotice: false })
			expect(service.cancellationState).toBe('none')
		} finally {
			service.onunload()
		}
	})

	it('retains upload advice across task updates and clears it for the next sync', () => {
		const service = new ProgressService({} as NutstorePlugin)
		service.onload()
		try {
			emitSyncProgress(2, [], null, true)
			expect(service.syncProgress.hasLargeUploads).toBe(true)
			emitSyncProgress(2, [], null)
			expect(service.syncProgress.hasLargeUploads).toBe(true)
			emitPreparingSync({ showNotice: false })
			expect(service.syncProgress.hasLargeUploads).toBeUndefined()
			emitSyncProgress(1, [], null, false)
			expect(service.syncProgress.hasLargeUploads).toBe(false)
		} finally {
			service.onunload()
		}
	})

	it.each(['zh', 'en'])(
		'shows mobile upload advice only for a sync with large uploads in %s',
		async (language) => {
			await i18n.changeLanguage(language)
			const { modal, progress, find } = mount()
			const hint = find('large-upload-hint')
			expect(hint.style.display).toBe('none')
			progress.syncProgress.hasLargeUploads = true
			modal.update()
			expect(hint.style.display).toBe('none')
			vi.mocked(Platform).isMobile = true
			modal.update()
			expect(hint.style.display).toBe('')
			expect(hint.textContent).toContain(i18n.t('settings.skipLargeFiles.name'))
			expect(hint.textContent).toContain('20 MB')
			expect(hint.textContent).toContain('40 MB')
			progress.preparationProgress = null
			progress.syncProgress.current = null
			modal.update()
			expect(hint.style.display).toBe('')
			progress.syncProgress.hasLargeUploads = false
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
		const { modal, progress, find, bar } = mount(scanning(2, 2))
		const icon = modal.titleEl.querySelector('svg')
		expect(bar.style.width).toBe('50%')
		progress.preparationProgress = scanning(3, 9)
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
		const { modal, progress, bar, find } = mount()
		progress.preparationProgress!.traversal!.phase = 'retrying'
		modal.update()
		expect(modal.modalEl.dataset.preparationPhase).toBe('retrying')
		expect(find('bar-label').textContent).toBe('2 / 5')
		expect(bar.style.width).toBe('40%')
		progress.preparationProgress = scanning(3, 2)
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
		const { modal, progress, find, track, bar } = mount()
		progress.preparationProgress = null
		modal.update()
		expect(find('label').textContent).toBe('Sync progress')
		expect(find('stats').style.display).toBe('none')
		expect(find('hint').style.display).toBe('none')
		expect(track.getAttribute('aria-valuenow')).toBe('0')
		expect(bar.classList.contains('nutstore-sync-progress-indeterminate')).toBe(
			false,
		)
		progress.syncEnd = true
		modal.update()
		expect(modal.modalEl.dataset.state).toBe('complete')
		expect(bar.style.width).toBe('100%')
		expect(find('files').style.display).toBe('none')
	})

	it.each(['zh', 'en'])(
		'keeps cancellation pending until the request settles in %s',
		async (language) => {
			await i18n.changeLanguage(language)
			const { modal, progress, find } = mount()
			progress.cancellationState = 'requested'
			modal.update()
			expect(modal.modalEl.dataset.state).toBe('cancelling')
			expect(modal.titleEl.textContent).toBe(i18n.t('sync.syncingFiles'))
			expect(modal.contentEl.querySelector('button')?.textContent).toBe(
				i18n.t('sync.cancelling'),
			)
			expect(find('summary').style.display).toBe('none')
			const stopButton = modal.contentEl.querySelector('button')!
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
			progress.cancellationState = 'complete'
			progress.preparationProgress = null
			modal.update()
			expect(modal.modalEl.dataset.state).toBe('cancelled')
			expect(modal.titleEl.textContent).toBe(i18n.t('sync.cancelled'))
		},
	)

	it('renders cache progress beside its label and clears it for preparation', () => {
		const { modal, progress, find } = mount()
		progress.preparationProgress = null
		modal.update()
		emitSyncUpdateMtimeProgress(4, 2)
		expect(
			find('cache').querySelector('.nutstore-sync-progress__meta')?.textContent,
		).toBe('Cache update progress50%')
		progress.preparationProgress = scanning()
		modal.update()
		expect(find('cache').style.display).toBe('none')
	})
})
