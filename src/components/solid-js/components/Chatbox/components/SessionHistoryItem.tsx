import { Menu, setIcon } from 'obsidian'
import { Show } from 'solid-js'
import { t } from '../../../i18n'
import type { ChatboxProps } from '../types'
import { formatTime } from '../utils'

export function SessionHistoryItem(props: {
	session: ChatboxProps['sessionHistory'][number]
	isActive: boolean
	isRunning?: boolean
	onSelect: (sessionId: string) => void
	onExport: (sessionId: string) => void
	onDelete: (sessionId: string) => void
}) {
	const activate = () => props.onSelect(props.session.id)

	return (
		<div
			role="button"
			tabIndex={0}
			class={`group relative w-full rounded-3 border px-3 py-3 text-left transition-colors overflow-hidden ${
				props.isActive
					? 'border-[var(--interactive-accent)] bg-[var(--background-secondary)]'
					: 'border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] hover:bg-[var(--background-modifier-hover)] hover:cursor-pointer'
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
					<div class="mt-2 flex items-center gap-1 text-xs text-[var(--text-muted)]">
						{formatTime(props.session.createdAt)}
						<Show when={props.isRunning}>
							<span class="font-medium text-[var(--color-yellow)]">
								· {t('chatbox.ui.history.sessionRunning')}
							</span>
						</Show>
					</div>
				</div>
				<div class="shrink-0">
					<div
						ref={(el) => setIcon(el, 'ellipsis-vertical')}
						class="flex justify-center items-center hover:text-[--interactive-accent] hover:cursor-pointer transition-colors"
						aria-label={t('chatbox.ui.history.sessionActions')}
						onClick={(event) => {
							event.preventDefault()
							event.stopPropagation()
							const menu = new Menu()
							menu.addItem((item) =>
								item
									.setTitle(t('chatbox.ui.actions.exportAsMarkdown'))
									.setIcon('download')
									.onClick(() => props.onExport(props.session.id)),
							)
							menu.addItem((item) => {
								item
									.setTitle(t('chatbox.ui.actions.deleteSession'))
									.setIcon('trash')
									.setWarning(true)
									.onClick(() => props.onDelete(props.session.id))
							})
							menu.showAtMouseEvent(event)
						}}
					/>
				</div>
			</div>
		</div>
	)
}
