import { For } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '../../i18n'
import { SessionHistoryItem } from './SessionHistoryItem'

export function SessionHistorySheet(props: {
	open: boolean
	sessions: ChatboxProps['sessionHistory']
	activeSessionId: string | undefined
	activeSessionIsRunning: boolean
	otherBusySessionIds: ChatboxProps['otherBusySessionIds']
	mountEl: HTMLElement
	contained: boolean
	onClose: () => void
	onNewSession: () => void
	onSwitchSession: (sessionId: string) => void
	onExportSession: (sessionId: string) => void
	onDelete: (sessionId: string) => void
}) {
	const runningSessionIds = () =>
		new Set([
			...(props.activeSessionId && props.activeSessionIsRunning
				? [props.activeSessionId]
				: []),
			...props.otherBusySessionIds,
		])

	return (
		<Portal mount={props.mountEl}>
			<div
				class={[
					':uno: inset-0 z-[200] bg-black/40 transition-opacity duration-300',
					props.contained ? ':uno: absolute' : ':uno: fixed',
					props.open
						? ':uno: opacity-100'
						: ':uno: pointer-events-none opacity-0',
				].join(' ')}
				onPointerDown={() => props.onClose()}
			/>
			<div
				class={[
					':uno: inset-x-0 bottom-0 z-[201] mx-auto max-w-xl rounded-t-4 border-t border-[var(--background-modifier-border)] bg-[var(--background-primary)] shadow-xl transition-transform duration-300 ease-out',
					props.contained ? ':uno: absolute' : ':uno: fixed',
					props.open ? ':uno: translate-y-0' : ':uno: translate-y-full',
				].join(' ')}
				style={!props.open ? { transform: 'translateY(100%)' } : undefined}
			>
				<div class=":uno: flex justify-center pb-1 pt-2">
					<div class=":uno: h-1 w-10 rounded-full bg-[var(--background-modifier-border)]" />
				</div>
				<div class=":uno: flex items-center justify-between border-b border-[var(--background-modifier-border)] px-4 py-3">
					<div class=":uno: text-sm font-semibold text-[var(--text-normal)]">
						{t('chatbox.ui.history.title')}
					</div>
					<button
						type="button"
						onClick={() => {
							props.onNewSession()
							props.onClose()
						}}
					>
						{t('chatbox.newChat')}
					</button>
				</div>
				<div class=":uno: max-h-[65vh] overflow-auto p-3 scrollbar-default">
					<div class=":uno: flex flex-col gap-2">
						<For each={props.sessions}>
							{(session) => (
								<SessionHistoryItem
									session={session}
									isActive={session.id === props.activeSessionId}
									isRunning={runningSessionIds().has(session.id)}
									onSelect={(sessionId) => {
										props.onSwitchSession(sessionId)
										props.onClose()
									}}
									onExport={(sessionId) => {
										props.onExportSession(sessionId)
										props.onClose()
									}}
									onDelete={(sessionId) => {
										props.onDelete(sessionId)
										props.onClose()
									}}
								/>
							)}
						</For>
					</div>
				</div>
			</div>
		</Portal>
	)
}
