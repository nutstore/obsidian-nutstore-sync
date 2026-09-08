import { describe, expect, it } from 'vitest'
import {
	applyObsidianModalMountTarget,
	CHATBOX_DIALOG_CONTAINED_MIN_WIDTH,
	resolveChatModalMountTarget,
} from './modal-mount'

function createClassList() {
	const classes = new Set<string>()
	return {
		add: (...values: string[]) => values.forEach((value) => classes.add(value)),
		toggle: (value: string, force?: boolean) => {
			if (force === false) classes.delete(value)
			else if (force === true || !classes.has(value)) classes.add(value)
			else classes.delete(value)
			return classes.has(value)
		},
		contains: (value: string) => classes.has(value),
	}
}

function createElement(width: number, connected = true) {
	const children: unknown[] = []
	const element = {
		clientWidth: width,
		isConnected: connected,
		classList: createClassList(),
		getBoundingClientRect: () => ({ width }),
		appendChild: (child: unknown) => {
			Object.assign(child as object, { parentElement: element })
			children.push(child)
			return child
		},
		children,
	} as unknown as HTMLElement & { children: unknown[] }
	return element
}

describe('chat modal mount target', () => {
	it('contains a modal in a connected chatbox at the width threshold', () => {
		const body = createElement(1200)
		const root = createElement(CHATBOX_DIALOG_CONTAINED_MIN_WIDTH)
		Object.assign(root, { ownerDocument: { body } })

		expect(resolveChatModalMountTarget(root)).toEqual({
			mountEl: root,
			contained: true,
			hostEl: root,
		})
	})

	it('falls back to the owning window body for a narrow chatbox', () => {
		const body = createElement(1200)
		const root = createElement(CHATBOX_DIALOG_CONTAINED_MIN_WIDTH - 1)
		Object.assign(root, { ownerDocument: { body } })

		expect(resolveChatModalMountTarget(root)).toEqual({
			mountEl: body,
			contained: false,
			hostEl: root,
		})
	})

	it('moves an open modal across the threshold as the chatbox resizes', () => {
		let width = CHATBOX_DIALOG_CONTAINED_MIN_WIDTH + 100
		let resizeCallback = () => {}
		let disconnected = false
		class FakeResizeObserver {
			constructor(callback: () => void) {
				resizeCallback = callback
			}
			observe() {}
			disconnect() {
				disconnected = true
			}
		}

		const body = createElement(1200)
		const root = createElement(width)
		Object.assign(root, {
			ownerDocument: {
				body,
				defaultView: { ResizeObserver: FakeResizeObserver },
			},
			getBoundingClientRect: () => ({ width }),
		})
		const containerEl = createElement(0)
		containerEl.classList.add('mod-dim')
		const modalEl = createElement(0)
		const cleanup = applyObsidianModalMountTarget(
			{ containerEl, modalEl } as unknown as Parameters<
				typeof applyObsidianModalMountTarget
			>[0],
			resolveChatModalMountTarget(root),
		)

		expect(containerEl.parentElement).toBe(root)
		width = CHATBOX_DIALOG_CONTAINED_MIN_WIDTH - 1
		resizeCallback()
		expect(containerEl.parentElement).toBe(body)
		expect(
			containerEl.classList.contains('ns-chatbox-contained-modal-container'),
		).toBe(false)
		expect(containerEl.classList.contains('mod-dim')).toBe(true)

		width = CHATBOX_DIALOG_CONTAINED_MIN_WIDTH
		resizeCallback()
		expect(containerEl.parentElement).toBe(root)
		expect(
			containerEl.classList.contains('ns-chatbox-contained-modal-container'),
		).toBe(true)
		expect(containerEl.classList.contains('mod-dim')).toBe(false)

		cleanup?.()
		expect(disconnected).toBe(true)
		expect(containerEl.classList.contains('mod-dim')).toBe(true)
	})

	it('uses clientWidth when the bounding box is temporarily empty', () => {
		const body = createElement(1200)
		const root = createElement(CHATBOX_DIALOG_CONTAINED_MIN_WIDTH)
		Object.assign(root, {
			ownerDocument: { body },
			getBoundingClientRect: () => ({ width: 0 }),
		})

		expect(resolveChatModalMountTarget(root).contained).toBe(true)
	})

	it('reparents and marks an Obsidian modal for contained positioning', () => {
		const root = createElement(800)
		const containerEl = createElement(0)
		containerEl.classList.add('mod-dim')
		const modalEl = createElement(0)
		const modal = { containerEl, modalEl } as unknown as Parameters<
			typeof applyObsidianModalMountTarget
		>[0]

		applyObsidianModalMountTarget(modal, {
			mountEl: root,
			contained: true,
		})

		expect(root.children).toContain(containerEl)
		expect(
			containerEl.classList.contains('ns-chatbox-contained-modal-container'),
		).toBe(true)
		expect(containerEl.classList.contains('mod-dim')).toBe(false)
		expect(modalEl.classList.contains('ns-chatbox-contained-modal')).toBe(true)
	})
})
