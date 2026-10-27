import { createEffect, onCleanup } from 'solid-js'
import type { ChatboxProps } from '~/ai/chat/ui/types'

export function MarkdownContent(props: {
	markdown: string
	renderMarkdown?: ChatboxProps['renderMarkdown']
	streaming?: boolean
	compact?: boolean
	details?: boolean
}) {
	let el: HTMLDivElement | undefined
	let cleanup: (() => void) | undefined
	let renderVersion = 0

	createEffect(() => {
		const markdown = props.markdown
		const streaming = props.streaming
		const renderMarkdown = props.renderMarkdown
		const currentVersion = ++renderVersion

		if (!el) {
			return
		}

		if (!markdown || !renderMarkdown) {
			cleanup?.()
			cleanup = undefined
			el.textContent = markdown
			return
		}

		// Keep the mounted version until its replacement is ready. Clearing it
		// while awaiting Markdown can shrink scrollHeight and clamp scrollTop.
		// eslint-disable-next-line obsidianmd/prefer-create-el -- Keep this optional-renderer component independent of host DOM extensions and in its owner document.
		const target = el.ownerDocument.createElement('div')
		target.className = 'ns-chatbox-markdown markdown-rendered'
		// New rows can move into the process while their Markdown is rendering.
		// Give those rows content immediately instead of an empty placeholder.
		if (!el.hasChildNodes()) el.textContent = markdown

		void Promise.resolve(renderMarkdown(target, markdown, { streaming })).then(
			(nextCleanup) => {
				if (currentVersion !== renderVersion) {
					if (typeof nextCleanup === 'function') {
						nextCleanup()
					}
					return
				}
				// Retain the render target itself: renderers may attach listeners
				// and cleanup ownership to it, rather than only to its children.
				el.replaceChildren(target)
				cleanup?.()
				cleanup = typeof nextCleanup === 'function' ? nextCleanup : undefined
			},
		)
	})

	onCleanup(() => {
		renderVersion += 1
		cleanup?.()
		cleanup = undefined
		el?.replaceChildren()
	})

	return (
		<div
			ref={el}
			class={[
				':uno: ns-chatbox-markdown markdown-rendered select-text text-[var(--text-normal)]',
				props.compact ? ':uno: text-xs leading-5' : ':uno: text-sm leading-6',
				props.details ? 'ns-chatbox-markdown--details' : '',
			].join(' ')}
		/>
	)
}
