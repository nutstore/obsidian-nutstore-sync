import { setIcon } from 'obsidian'
import {
	acceptCompletion,
	autocompletion,
	completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder, tooltips } from '@codemirror/view'
import {
	createEffect,
	createUniqueId,
	onCleanup,
	onMount,
	untrack,
} from 'solid-js'
import { shouldSubmitChatInput } from '../utils'
import { t } from '../../i18n'
import {
	composerCompletions,
	composerTrigger,
	type ComposerCommand,
} from './composer-completions'

const COMPLETION_GAP = 8

/** Plain text remains the draft format; editor history belongs to one session. */
export function ChatComposer(props: {
	ref: (element: HTMLDivElement) => void
	value: string
	sessionId: string | undefined
	placeholder: string
	height: string | undefined
	/** Surface the completion panel must float above without covering. */
	completionAnchor?: () => HTMLElement | undefined
	onChange: (text: string) => void
	onSubmit: () => void
	mentionPaths: () => string[]
	onMention: (path: string) => void
	commands: () => ComposerCommand[]
	onPasteImages: (files: File[]) => void
}) {
	let host!: HTMLDivElement
	let completionLayer!: HTMLDivElement
	let view: EditorView | undefined
	let sessionId = untrack(() => props.sessionId)
	let positionFrame = 0
	let positionWindow: Window | undefined
	const hint = new Compartment()
	const labelId = createUniqueId()

	/**
	 * Completion tooltips use the trigger as their anchor. Shift them to the
	 * composer card's top edge so the floating panel never covers the input.
	 */
	function positionCompletions() {
		if (!view) return
		const cursor = view.state.selection.main.head
		const trigger = composerTrigger(view.state.sliceDoc(0, cursor))
		const anchor = view.coordsAtPos(trigger?.from ?? cursor)
		const surface = props.completionAnchor?.() ?? host
		if (!anchor) return
		const surfaceTop = surface.getBoundingClientRect().top
		completionLayer.style.setProperty(
			'--ns-composer-completion-above-offset',
			`${Math.max(0, anchor.top - surfaceTop + COMPLETION_GAP)}px`,
		)
		completionLayer.style.setProperty(
			'--ns-composer-completion-below-offset',
			`${Math.max(0, anchor.bottom - surfaceTop + COMPLETION_GAP)}px`,
		)
		const popup = completionLayer.querySelector<HTMLElement>(
			'.cm-tooltip.ns-composer-completions',
		)
		const popupLeft = Number.parseFloat(popup?.style.left ?? '')
		if (Number.isFinite(popupLeft)) {
			completionLayer.style.setProperty(
				'--ns-composer-completion-x',
				`${-popupLeft}px`,
			)
		}
	}

	function scheduleCompletionPosition() {
		const win = view?.dom.ownerDocument.defaultView
		if (!win) return
		positionWindow?.cancelAnimationFrame(positionFrame)
		positionWindow = win
		// Layout callbacks own this imperative measurement, outside Solid tracking.
		// eslint-disable-next-line solid/reactivity -- CM6 and layout own the callback lifecycle.
		positionFrame = win.requestAnimationFrame(() => {
			positionFrame = 0
			positionCompletions()
		})
	}

	const extensions = (hintText: string) => [
		history(),
		// Position the completion surface inside the composer instead of
		// anchoring its width and horizontal origin to the text cursor.
		tooltips({ parent: completionLayer, position: 'absolute' }),
		autocompletion({
			override: [
				composerCompletions({
					paths: () => props.mentionPaths(),
					mention: (path) => props.onMention(path),
					commands: () => props.commands(),
				}),
			],
			defaultKeymap: false,
			icons: false,
			tooltipClass: () => 'ns-composer-completions',
			optionClass: (completion) =>
				completion.type === 'command'
					? 'ns-completion-command-option'
					: completion.detail
						? 'ns-completion-file-option'
						: '',
			addToOptions: [
				{
					position: 40,
					render(completion, _state, editor) {
						const document = editor.dom.ownerDocument
						const row = document.win.createSpan()
						row.className =
							completion.type === 'command'
								? 'ns-completion-row ns-completion-command'
								: completion.detail
									? 'ns-completion-row ns-completion-file'
									: 'ns-completion-row'
						row.title =
							completion.type === 'command'
								? (completion.detail ?? completion.label)
								: completion.label
						if (completion.type !== 'command') {
							const icon = row.appendChild(document.win.createSpan())
							icon.className = 'ns-completion-icon'
							icon.setAttribute('aria-hidden', 'true')
							setIcon(
								icon,
								completion.type === 'drawing' ? 'pen-tool' : 'file-text',
							)
						}
						const text = row.appendChild(document.win.createSpan())
						text.className = 'ns-completion-text'
						const label = text.appendChild(document.win.createSpan())
						label.className = 'ns-completion-name'
						label.textContent = completion.displayLabel ?? completion.label
						if (completion.detail) {
							const detail = text.appendChild(document.win.createSpan())
							detail.className = 'ns-completion-description'
							detail.textContent = completion.detail
						}
						return row
					},
				},
			],
			aboveCursor: true,
			activateOnTypingDelay: 50,
			interactionDelay: 0,
		}),
		Prec.highest(keymap.of(completionKeymap)),
		keymap.of([...defaultKeymap, ...historyKeymap]),
		EditorView.lineWrapping,
		hint.of(placeholder(hintText)),
		EditorView.contentAttributes.of({
			// Obsidian treats aria-label as a hover tooltip; reference a label instead.
			'aria-labelledby': labelId,
		}),
		// CM6 invokes this callback on editor updates, outside Solid tracking.
		// eslint-disable-next-line solid/reactivity -- CM6 owns the callback lifecycle.
		EditorView.updateListener.of((update) => {
			if (update.docChanged) props.onChange(update.state.doc.toString())
			scheduleCompletionPosition()
		}),
		Prec.high(
			EditorView.domEventHandlers({
				keydown(event, editor) {
					if (!shouldSubmitChatInput(event, editor.composing)) return false
					if (acceptCompletion(editor)) {
						// This handler runs before CodeMirror's keymap. Confirm the
						// selected option here; pending queries must still allow sending.
						event.preventDefault()
						return true
					}
					event.preventDefault()
					props.onSubmit()
					return true
				},
				paste(event) {
					const files = Array.from(event.clipboardData?.items ?? [])
						.filter(
							(item) => item.kind === 'file' && item.type.startsWith('image/'),
						)
						.map((item) => item.getAsFile())
						.filter((file): file is File => !!file)
					if (!files.length) return false
					event.preventDefault()
					props.onPasteImages(files)
					return true
				},
			}),
		),
	]
	onMount(() => {
		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: props.value,
				extensions: extensions(props.placeholder),
			}),
		})
		positionCompletions()
		const resizeObserver = new ResizeObserver(scheduleCompletionPosition)
		resizeObserver.observe(host)
		const surface = props.completionAnchor?.()
		if (surface) resizeObserver.observe(surface)
		const win = view.dom.ownerDocument.defaultView
		win?.addEventListener('resize', scheduleCompletionPosition)
		view.scrollDOM.addEventListener('scroll', scheduleCompletionPosition)
		onCleanup(() => {
			positionWindow?.cancelAnimationFrame(positionFrame)
			resizeObserver.disconnect()
			win?.removeEventListener('resize', scheduleCompletionPosition)
			view?.scrollDOM.removeEventListener('scroll', scheduleCompletionPosition)
			view?.destroy()
		})
	})
	createEffect(() => {
		const text = props.value
		const nextSession = props.sessionId
		if (!view) return
		if (sessionId !== nextSession) {
			sessionId = nextSession
			view.setState(
				EditorState.create({
					doc: text,
					extensions: extensions(props.placeholder),
				}),
			)
		} else if (view.state.doc.toString() !== text) {
			// External draft restoration must not expose the previous draft through undo.
			view.setState(
				EditorState.create({
					doc: text,
					extensions: extensions(props.placeholder),
				}),
			)
		}
	})
	createEffect(() => {
		const text = props.placeholder
		view?.dispatch({ effects: hint.reconfigure(placeholder(text)) })
	})
	return (
		<>
			<span id={labelId} hidden>
				{t('chatbox.ui.labels.messageInput')}
			</span>
			<div
				ref={(element) => {
					host = element
					props.ref(element)
				}}
				class="ns-chat-composer"
				style={{ height: props.height }}
			/>
			<div ref={completionLayer} class="ns-completion-layer" />
		</>
	)
}
