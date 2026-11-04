// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	mountTaskSelectionVirtualList,
	type TaskSelectionItem,
	type TaskSelectionVirtualListController,
} from './index'

const VIEWPORT_HEIGHT = 400
const ROW_HEIGHT = 95

/** jsdom has no layout: give the scroll viewport and every row a fixed size. */
beforeAll(() => {
	const size = (name: string, value: number) =>
		Object.defineProperty(HTMLElement.prototype, name, {
			configurable: true,
			get: () => value,
		})
	size('clientHeight', VIEWPORT_HEIGHT)
	size('clientWidth', 800)
	size('offsetHeight', ROW_HEIGHT)
	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(callback: ResizeObserverCallback) {
				resizeCallbacks.push(callback)
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
})

/** jsdom never resizes anything; replay what a real observer would report. */
const resizeCallbacks: ResizeObserverCallback[] = []
const reportResize = (target: HTMLElement) => {
	for (const callback of resizeCallbacks)
		callback(
			[{ target } as unknown as ResizeObserverEntry],
			{} as ResizeObserver,
		)
}

const items = (count: number): TaskSelectionItem[] =>
	Array.from({ length: count }, (_, index) => ({
		id: String(index),
		action: index % 2 ? '创建目录 Create 🌱' : '上传 Upload 📘',
		localPath: `笔记 Notes/任务 Task ${String(index).padStart(5, '0')}🌿`,
		remotePath: `/remote 远端/任务 Task ${String(index).padStart(5, '0')}🌿`,
		checked: true,
	}))

let controller: TaskSelectionVirtualListController | undefined
afterEach(() => {
	controller?.destroy()
	controller = undefined
	document.body.replaceChildren()
})

function mount(count: number) {
	const onToggle = vi.fn()
	const onToggleMany = vi.fn()
	const host = document.body.appendChild(document.createElement('div'))
	controller = mountTaskSelectionVirtualList(host, {
		items: items(count),
		onToggle,
		onToggleMany,
	})
	return { host, onToggle, onToggleMany }
}

/** Rows are the absolutely positioned children of the sized spacer. */
const rows = (host: HTMLElement) => [
	...host.querySelectorAll<HTMLElement>('[style*="translateY"]'),
]

const flush = () => new Promise((resolve) => setTimeout(resolve, 30))

describe('TaskSelectionVirtualList windowing', () => {
	it('mounts only the rows near the viewport for a very large list', async () => {
		const { host } = mount(10_000)
		await flush()
		const mounted = rows(host)
		expect(mounted.length).toBeGreaterThan(3)
		expect(mounted.length).toBeLessThan(60)
		expect(mounted[0].textContent).toContain('任务 Task 00000🌿')
		expect(host.textContent).not.toContain('任务 Task 09999🌿')
	})

	it('reserves the full list height so the scrollbar covers every row', async () => {
		const { host } = mount(10_000)
		await flush()
		const spacer = host.querySelector<HTMLElement>(
			'[style*="position: relative"]',
		)!
		expect(Number.parseFloat(spacer.style.height)).toBe(10_000 * ROW_HEIGHT)
	})

	it('re-flows later rows when a mounted row grows after its first measure', async () => {
		const { host } = mount(100)
		await flush()
		const [first] = rows(host)
		const spacer = host.querySelector<HTMLElement>(
			'[style*="position: relative"]',
		)!
		Object.defineProperty(first, 'offsetHeight', { value: 2 * ROW_HEIGHT })
		reportResize(first)
		await flush()
		expect(Number.parseFloat(spacer.style.height)).toBe(101 * ROW_HEIGHT)
		expect(rows(host)[1].style.transform).toBe(
			`translateY(${2 * ROW_HEIGHT}px)`,
		)
	})

	it('reveals the last task after scrolling to the end', async () => {
		const { host } = mount(10_000)
		await flush()
		const scroller = host.querySelector<HTMLElement>(
			'.overflow-auto, [class*="overflow-auto"]',
		)!
		scroller.scrollTop = 10_000 * ROW_HEIGHT
		scroller.dispatchEvent(new Event('scroll'))
		await flush()
		expect(host.textContent).toContain('任务 Task 09999🌿')
		expect(host.textContent).not.toContain('任务 Task 00000🌿')
		expect(rows(host).length).toBeLessThan(60)
	})

	it('reports the original index when a row is toggled', async () => {
		const { host, onToggle } = mount(10_000)
		await flush()
		rows(host)[2].querySelector<HTMLInputElement>('input')!.click()
		expect(onToggle).toHaveBeenCalledWith(2, false)
	})

	it('filters across all items, not just the mounted ones', async () => {
		const { host } = mount(10_000)
		await flush()
		const search = host.querySelector<HTMLInputElement>('input[type="text"]')!
		search.value = '09999'
		search.dispatchEvent(new Event('input', { bubbles: true }))
		await flush()
		expect(rows(host)).toHaveLength(1)
		expect(rows(host)[0].textContent).toContain('任务 Task 09999🌿')
	})

	it('shows the empty state when nothing matches', async () => {
		const { host } = mount(50)
		await flush()
		const search = host.querySelector<HTMLInputElement>('input[type="text"]')!
		search.value = 'no-such-path 无匹配🌱'
		search.dispatchEvent(new Event('input', { bubbles: true }))
		await flush()
		expect(rows(host)).toHaveLength(0)
	})
})
