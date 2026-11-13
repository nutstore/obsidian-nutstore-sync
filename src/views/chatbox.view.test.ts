// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceLeaf } from 'obsidian'
import type NutstorePlugin from '~/index'

const host = vi.hoisted(() => {
	class Component {
		children: Component[] = []
		loaded = false
		loadCount = 0
		unloadCount = 0
		load() {
			this.loaded = true
			this.loadCount += 1
		}
		unload() {
			this.loaded = false
			this.unloadCount += 1
		}
		addChild<T extends Component>(child: T): T {
			this.children.push(child)
			if (this.loaded) child.load()
			return child
		}
		removeChild<T extends Component>(child: T): T {
			const index = this.children.indexOf(child)
			if (index !== -1) this.children.splice(index, 1)
			child.unload()
			return child
		}
	}
	class ItemView extends Component {
		contentEl = document.createElement('div')
		app: {
			workspace: {
				on: () => object
				getActiveViewOfType: () => null
			}
			vault: { on: () => object }
		}
		constructor(readonly leaf: WorkspaceLeaf) {
			super()
			this.loaded = true
			this.app = {
				workspace: {
					on: () => ({}),
					getActiveViewOfType: () => null,
				},
				vault: { on: () => ({}) },
			}
		}
		registerEvent() {}
		registerDomEvent() {}
	}
	return {
		Component,
		ItemView,
		render: vi.fn(),
	}
})

vi.mock('obsidian', () => ({
	Component: host.Component,
	ItemView: host.ItemView,
	MarkdownView: class {},
	MarkdownRenderer: { render: host.render },
	normalizePath: (path: string) => path,
	TFile: class {},
	TFolder: class {},
	WorkspaceLeaf: class {},
}))
vi.mock('~/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('~/components/ChatWorkspacePanel', () => ({
	ChatWorkspacePanel: class {},
}))
vi.mock('~/ai/tools/resource-data-url', () => ({
	resolveResourceDataUrl: vi.fn(),
}))
vi.mock('../components/solid-js', () => ({ mountChatbox: vi.fn() }))
vi.mock('./chatbox-selection-highlight', () => ({
	hideChatboxSelectionHighlight: vi.fn(),
	showChatboxSelectionHighlight: vi.fn(),
}))
vi.mock('./chatbox-code-preview', () => ({ enhanceHtmlCodeBlocks: vi.fn() }))

import ChatboxView from './chatbox.view'

type HostComponent = InstanceType<typeof host.Component>

type RenderMarkdown = (
	el: HTMLElement,
	markdown: string,
	options?: { streaming?: boolean },
) => Promise<(() => void) | undefined>

async function renderPlainMarkdown(
	_app: unknown,
	_markdown: string,
	el: HTMLElement,
) {
	el.appendChild(document.createElement('p'))
}

function createView(render = renderPlainMarkdown) {
	host.render.mockImplementation(render)
	const plugin = {
		ai: { chat: { subscribe: () => () => {} } },
		protocolService: {},
	} as unknown as NutstorePlugin
	const view = new ChatboxView({} as WorkspaceLeaf, plugin)
	return view as unknown as {
		children: HostComponent[]
		renderMarkdown: RenderMarkdown
	}
}

beforeEach(() => {
	Object.assign(document, { win: window })
	Object.assign(window, {
		win: window,
		createDiv: (options?: { cls?: string }) => {
			const element = document.createElement('div')
			if (options?.cls) element.className = options.cls
			return element
		},
	})
})

afterEach(() => {
	vi.clearAllMocks()
})

describe('chat markdown rendering lifecycle', () => {
	it('detaches and unloads the render component when its output is replaced', async () => {
		const view = createView()
		const el = document.createElement('div')

		const cleanup = await view.renderMarkdown(el, '# 示例 🌿')
		expect(view.children).toHaveLength(1)
		expect(view.children[0]?.loaded).toBe(true)
		expect(view.children[0]?.loadCount).toBe(1)

		cleanup?.()

		expect(view.children).toHaveLength(0)
		expect(host.render).toHaveBeenCalledOnce()
	})

	it('detaches the render component when Markdown rendering fails', async () => {
		const view = createView(async () => {
			throw new Error('render failed')
		})
		const el = document.createElement('div')

		await view.renderMarkdown(el, '# 示例 🌿')

		expect(view.children).toHaveLength(0)
		expect(el.textContent).toBe('# 示例 🌿')
	})
})
