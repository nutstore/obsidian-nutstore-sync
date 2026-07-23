import { createEffect, onCleanup } from 'solid-js'
import type { ChatboxProps } from '~/ai/chat/ui/types'

export function MarkdownContent(props: {
	markdown: string
	renderMarkdown?: ChatboxProps['renderMarkdown']
	compact?: boolean
	details?: boolean
}) {
	let el: HTMLDivElement | undefined
	let cleanup: (() => void) | undefined
	let renderVersion = 0

	createEffect(() => {
		const markdown = props.markdown
		const renderMarkdown = props.renderMarkdown
		const currentVersion = ++renderVersion

		cleanup?.()
		cleanup = undefined

		if (!el) {
			return
		}

		el.replaceChildren()

		if (!markdown) {
			return
		}

		if (!renderMarkdown) {
			el.textContent = markdown
			return
		}

		void Promise.resolve(renderMarkdown(el, markdown)).then((nextCleanup) => {
			if (currentVersion !== renderVersion) {
				if (typeof nextCleanup === 'function') {
					nextCleanup()
				}
				return
			}
			cleanup = typeof nextCleanup === 'function' ? nextCleanup : undefined
		})
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
			class={`ns-chatbox-markdown markdown-rendered select-text text-[var(--text-normal)] ${
				props.compact ? 'text-xs leading-5' : 'text-sm leading-6'
			} ${props.details ? 'ns-chatbox-markdown--details' : ''}`}
		/>
	)
}
