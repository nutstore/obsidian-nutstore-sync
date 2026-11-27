// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { obsidianRuntime } from '@test/obsidian-runtime'
import type { Component, WorkspaceLeaf } from 'obsidian'
import type NutstorePlugin from '~/index'

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

type InspectableComponent = Component & {
	loaded: boolean
	loadCount: number
	unloadCount: number
}

type RenderMarkdown = (
	el: HTMLElement,
	markdown: string,
	options?: { streaming?: boolean },
) => Promise<(() => void) | undefined>

const renderSpy = vi.fn()

async function renderPlainMarkdown(
	_app: unknown,
	_markdown: string,
	el: HTMLElement,
) {
	el.appendChild(document.createElement('p'))
}

function createView(render = renderPlainMarkdown) {
	renderSpy.mockImplementation(render)
	obsidianRuntime.markdownRenderHandler = renderSpy
	const plugin = {
		ai: { chat: { subscribe: () => () => {} } },
		protocolService: {},
	} as unknown as NutstorePlugin
	const view = new ChatboxView({} as WorkspaceLeaf, plugin)
	return view as unknown as {
		children: InspectableComponent[]
		renderMarkdown: RenderMarkdown
	}
}

beforeEach(() => {
	obsidianRuntime.reset()
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
	obsidianRuntime.reset()
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
		expect(renderSpy).toHaveBeenCalledOnce()
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
