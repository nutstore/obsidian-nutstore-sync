import { For, Show } from 'solid-js'
import { Portal } from 'solid-js/web'

import type { ChatAgentView, ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '../../i18n'
import { MessageCard } from './MessageCard'

export function SubagentTimelineDialog(props: {
	agent: ChatAgentView | undefined
	now: number
	mountEl: HTMLElement
	contained: boolean
	renderMarkdown?: ChatboxProps['renderMarkdown']
	getSubagent?: (agentId: string) => ChatAgentView | undefined
	onSelectAgent: (agentId: string) => void
	onOpenFileChange?: ChatboxProps['onOpenFileChange']
	onClose: () => void
}) {
	return (
		<Show when={props.agent}>
			{(agent) => (
				<Portal mount={props.mountEl}>
					<div
						class={[
							':uno: inset-0 z-[220] flex items-center justify-center bg-black/40 p-4',
							props.contained ? ':uno: absolute' : ':uno: fixed',
						].join(' ')}
						onPointerDown={(event) => {
							if (event.target === event.currentTarget) props.onClose()
						}}
					>
						<div class=":uno: flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-4 border border-[var(--background-modifier-border)] bg-[var(--background-primary)] shadow-xl">
							<div class=":uno: flex items-center justify-between gap-3 border-b border-[var(--background-modifier-border)] px-4 py-3">
								<div class=":uno: min-w-0">
									<div class=":uno: truncate text-sm font-semibold">
										{t('chatbox.ui.dialogs.subagentTimeline.title')} ·{' '}
										{agent().type}
									</div>
									<div class=":uno: truncate text-xs text-[var(--text-muted)]">
										{agent().id} · {agent().status}
									</div>
								</div>
								<button type="button" onClick={props.onClose}>
									{t('chatbox.ui.actions.close')}
								</button>
							</div>
							<div class=":uno: flex-1 overflow-y-auto p-4 scrollbar-default">
								<div class=":uno: mx-auto flex w-full max-w-3xl flex-col gap-3">
									<For each={agent().timeline}>
										{(item) => (
											<MessageCard
												item={item}
												now={props.now}
												renderMarkdown={props.renderMarkdown}
												getSubagent={props.getSubagent}
												onOpenSubagent={props.onSelectAgent}
												onOpenFileChange={props.onOpenFileChange}
											/>
										)}
									</For>
									<Show when={agent().timeline.length === 0}>
										<div class=":uno: rounded-3 border border-dashed border-[var(--background-modifier-border)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
											{t('chatbox.ui.states.noSubagentMessages')}
										</div>
									</Show>
								</div>
							</div>
						</div>
					</div>
				</Portal>
			)}
		</Show>
	)
}
