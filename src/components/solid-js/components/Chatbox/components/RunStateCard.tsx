import { Show } from 'solid-js'
import { t } from '../../../i18n'
import type { ChatboxProps } from '../types'
import { runStateLabel } from '../utils'

export function RunStateCard(props: {
	runState: ChatboxProps['runState']
	onStop?: ChatboxProps['onStopActiveRun']
}) {
	const label = () => runStateLabel(props.runState)
	const canStop = () =>
		props.runState === 'thinking' || props.runState === 'waiting_for_tools'

	return (
		<Show when={label()}>
			<div class="rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] p-3">
				<div class="flex items-center justify-between gap-3 rounded-2 bg-[var(--background-secondary)] px-3 py-2 text-sm text-[var(--text-normal)]">
					<div class="flex min-w-0 items-center gap-3">
						<svg
							class="h-4 w-4 shrink-0 animate-spin text-[var(--interactive-accent)]"
							viewBox="0 0 24 24"
							fill="none"
							aria-hidden="true"
						>
							<circle
								cx="12"
								cy="12"
								r="9"
								stroke="currentColor"
								stroke-width="3"
								stroke-linecap="round"
								stroke-dasharray="42 16"
							/>
						</svg>
						<div class="min-w-0 font-medium">{label()}</div>
					</div>
					<Show when={canStop() && props.onStop}>
						<button
							class="shrink-0"
							type="button"
							onClick={() => props.onStop?.()}
						>
							{t('chatbox.ui.actions.stopRun')}
						</button>
					</Show>
				</div>
			</div>
		</Show>
	)
}
