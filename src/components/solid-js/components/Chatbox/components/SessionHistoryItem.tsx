import { Menu } from 'obsidian'
import { Show } from 'solid-js'
import { t } from '../../../i18n'
import type { ChatboxProps } from '~/ai/chat/ui/types'
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
			class={[
				':uno: group relative w-full rounded-3 border px-3 py-3 text-left transition-colors overflow-hidden',
				props.isActive
					? ':uno: border-[var(--interactive-accent)] bg-[var(--background-secondary)]'
					: ':uno: border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] hover:bg-[var(--background-modifier-hover)] hover:cursor-pointer',
			].join(' ')}
			onClick={activate}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault()
					activate()
				}
			}}
		>
			<Show when={props.isActive}>
				<div class=":uno: absolute inset-y-3 left-0 w-1 rounded-r-full bg-[var(--interactive-accent)]" />
			</Show>
			<div class=":uno: flex items-start justify-between gap-3">
				<div class=":uno: min-w-0 flex-1">
					<div class=":uno: truncate pr-1 text-sm font-medium text-[var(--text-normal)]">
						{props.session.title}
					</div>
					<div class=":uno: mt-2 flex items-center gap-1 text-xs text-[var(--text-muted)]">
						{formatTime(props.session.createdAt)}
						<Show when={props.isRunning}>
							<span class=":uno: font-medium text-[var(--color-yellow)]">
								· {t('chatbox.ui.history.sessionRunning')}
							</span>
						</Show>
					</div>
				</div>
				<div class=":uno: shrink-0">
					<div
						class=":uno: i-lucide-ellipsis-vertical flex justify-center items-center hover:text-[--interactive-accent] hover:cursor-pointer transition-colors"
						aria-label={t('chatbox.ui.history.sessionActions')}
						onClick={(event) => {
							event.preventDefault()
							event.stopPropagation()
							const sessionId = props.session.id
							const onExport = props.onExport
							const onDelete = props.onDelete
							const menu = new Menu()
							menu.addItem((item) =>
								item
									.setTitle(t('chatbox.ui.actions.exportAsMarkdown'))
									.setIcon('download')
									.onClick(() => onExport(sessionId)),
							)
							menu.addItem((item) => {
								item
									.setTitle(t('chatbox.ui.actions.deleteSession'))
									.setIcon('trash')
									.setWarning(true)
									.onClick(() => onDelete(sessionId))
							})
							menu.showAtMouseEvent(event)
						}}
					/>
				</div>
			</div>
		</div>
	)
}
