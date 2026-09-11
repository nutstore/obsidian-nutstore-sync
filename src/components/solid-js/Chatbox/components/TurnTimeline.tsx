import {
	For,
	Show,
	createMemo,
	createSignal,
	type Accessor,
	type JSX,
} from 'solid-js'
import type { ChatRunState } from '~/ai/chat/types'
import type { ChatTimelineMessageItem } from '~/ai/chat/ui/types'
import { t } from '../../i18n'
import {
	projectTurns,
	turnProcessTitle,
	type TurnMessage,
} from '../turn-projection'
import {
	CollapsibleAppearance,
	TitledCollapsibleBlock,
} from './CollapsibleBlock'

export function TurnTimeline(props: {
	timeline: ChatTimelineMessageItem[]
	sessionId?: string
	runState: ChatRunState
	/** Row keys preserve mounted content; the accessor supplies each fresh projection. */
	children: (row: Accessor<TurnMessage>, process?: boolean) => JSX.Element
}) {
	const rows = createMemo(
		() =>
			new Map(
				projectTurns(props.timeline, props.sessionId, props.runState).map(
					(row) => [row.key, row],
				),
			),
	)
	// State belongs to the turn, even if its process temporarily has no blocks.
	const [expanded, setExpanded] = createSignal<ReadonlyMap<string, boolean>>(
		new Map(),
	)
	return (
		<For each={[...rows().keys()]}>
			{(key) => {
				const row = () => rows().get(key)
				const message = () => {
					const value = row()
					return value?.kind === 'message' ? value : undefined
				}
				const process = () => {
					const value = row()
					return value?.kind === 'process' ? value : undefined
				}
				return (
					<>
						<Show when={message()}>{(value) => props.children(value)}</Show>
						<Show when={process()}>
							{(value) => {
								const messages = createMemo(
									() =>
										new Map(
											value().messages.map((message) => [message.key, message]),
										),
								)
								return (
									<TitledCollapsibleBlock
										appearance="plain"
										open={expanded().get(key) ?? false}
										onOpenChange={(open) =>
											setExpanded((previous) =>
												new Map(previous).set(key, open),
											)
										}
										title={
											<span
												classList={{
													'chatbox-process-title-active': value().active,
												}}
											>
												{turnProcessTitle(value(), {
													thinking: t('chatbox.ui.states.thinking'),
													completed: t('chatbox.ui.states.thoughtProcess'),
												})}
											</span>
										}
									>
										<CollapsibleAppearance.Provider value="plain">
											<div class=":uno: chatbox-process-flow flex min-w-0 flex-col gap-3">
												<For each={[...messages().keys()]}>
													{(messageKey) => {
														const message = createMemo(() =>
															messages().get(messageKey)!,
														)
														return <>{props.children(message, true)}</>
													}}
												</For>
											</div>
										</CollapsibleAppearance.Provider>
									</TitledCollapsibleBlock>
								)
							}}
						</Show>
					</>
				)
			}}
		</For>
	)
}
