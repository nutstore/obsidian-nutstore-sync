import { For } from 'solid-js'
import { Portal } from 'solid-js/web'
import { t } from '../../../i18n'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { SessionHistoryItem } from './SessionHistoryItem'

export function SessionHistorySheet(props: {
	open: boolean
	sessions: ChatboxProps['sessionHistory']
	activeSessionId: string | undefined
	otherSessionTasks: ChatboxProps['otherSessionTasks']
	otherBusySessionIds: ChatboxProps['otherBusySessionIds']
	mountEl: HTMLElement | undefined
	contained?: boolean
	onClose: () => void
	onNewSession: () => void
	onSwitchSession: (sessionId: string) => void
	onExportSession: (sessionId: string) => void
	onDelete: (sessionId: string) => void
}) {
	const runningSessionIds = () =>
		new Set([
			...props.otherBusySessionIds,
			...props.otherSessionTasks
				.filter((t) => t.status === 'running' || t.status === 'queued')
				.map((t) => t.sessionId),
		])

	return (
		<Portal mount={props.mountEl ?? document.body}>
			<div
				class={`${props.contained ? 'absolute' : 'fixed'} inset-0 z-[200] bg-black/40 transition-opacity duration-300 ${props.open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
				onPointerDown={props.onClose}
			/>
			<div
				class={`${props.contained ? 'absolute' : 'fixed'} inset-x-0 bottom-0 z-[201] mx-auto max-w-xl rounded-t-4 border-t border-[var(--background-modifier-border)] bg-[var(--background-primary)] shadow-xl transition-transform duration-300 ease-out ${props.open ? 'translate-y-0' : 'translate-y-full'}`}
			>
				<div class="flex justify-center pb-1 pt-2">
					<div class="h-1 w-10 rounded-full bg-[var(--background-modifier-border)]" />
				</div>
				<div class="flex items-center justify-between border-b border-[var(--background-modifier-border)] px-4 py-3">
					<div class="text-sm font-semibold text-[var(--text-normal)]">
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
				<div class="max-h-[65vh] overflow-auto p-3 scrollbar-default">
					<div class="flex flex-col gap-2">
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
