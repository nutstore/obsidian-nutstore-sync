import { Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { t } from '../i18n'
import type { ChatboxProps } from '../types'
import { formatTime } from '../utils'

export function SessionHistoryItem(props: {
	session: ChatboxProps['sessionHistory'][number]
	isActive: boolean
	onSelect: (sessionId: string) => void
	onExport: (sessionId: string) => void
	onDelete: (sessionId: string) => void
}) {
	const [menuOpen, setMenuOpen] = createSignal(false)
	let menuEl: HTMLDivElement | undefined
	let actionsButtonEl: HTMLButtonElement | undefined

	createEffect(() => {
		if (!menuOpen()) {
			return
		}
		const viewDocument = menuEl?.ownerDocument ?? document
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target
			if (!target || typeof target !== 'object' || !('nodeType' in target)) {
				return
			}
			const node = target as Node
			if (menuEl?.contains(node) || actionsButtonEl?.contains(node)) {
				return
			}
			setMenuOpen(false)
		}
		viewDocument.addEventListener('pointerdown', onPointerDown)
		onCleanup(() => {
			viewDocument.removeEventListener('pointerdown', onPointerDown)
		})
	})

	const activate = () => props.onSelect(props.session.id)

	return (
		<div
			role="button"
			tabIndex={0}
			class={`group relative w-full rounded-3 border px-3 py-3 text-left transition-colors ${
				menuOpen() ? 'z-30 overflow-visible' : 'overflow-hidden'
			} ${
				props.isActive
					? 'border-[var(--interactive-accent)] bg-[var(--background-secondary)]'
					: 'border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] hover:bg-[var(--background-modifier-hover)]'
			}`}
			onClick={activate}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault()
					activate()
				}
			}}
		>
			<Show when={props.isActive}>
				<div class="absolute inset-y-3 left-0 w-1 rounded-r-full bg-[var(--interactive-accent)]" />
			</Show>
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0 flex-1">
					<div class="truncate pr-1 text-sm font-medium text-[var(--text-normal)]">
						{props.session.title}
					</div>
					<div class="mt-2 text-xs text-[var(--text-muted)]">
						{formatTime(props.session.createdAt)}
					</div>
				</div>
				<div class="relative shrink-0">
					<button
						ref={actionsButtonEl}
						class="py-1 px-2"
						type="button"
						aria-label={t('sessionActions')}
						onClick={(event) => {
							event.preventDefault()
							event.stopPropagation()
							setMenuOpen((value) => !value)
						}}
					>
						⋯
					</button>
					<Show when={menuOpen()}>
						<div
							ref={menuEl}
							class="absolute right-0 top-8 z-20 min-w-36 rounded-2 bg-[var(--background-primary)] shadow-lg flex flex-col p-1 gap-1 md:p-2 md:gap-2"
						>
							<button
								class="w-full text-xs"
								onClick={(event) => {
									event.preventDefault()
									event.stopPropagation()
									setMenuOpen(false)
									props.onExport(props.session.id)
								}}
							>
								{t('exportAsMarkdown')}
							</button>
							<button
								class="w-full text-xs mod-warning"
								onClick={(event) => {
									event.preventDefault()
									event.stopPropagation()
									setMenuOpen(false)
									props.onDelete(props.session.id)
								}}
							>
								{t('deleteSession')}
							</button>
						</div>
					</Show>
				</div>
			</div>
		</div>
	)
}
