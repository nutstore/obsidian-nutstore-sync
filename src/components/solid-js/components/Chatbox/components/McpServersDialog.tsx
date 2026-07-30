import { For, Show, createSignal } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { ChatMcpServerOption } from '~/ai/chat/ui/types'
import { t } from '../../../i18n'

interface McpServersDialogProps {
	servers: ChatMcpServerOption[]
	mountEl: HTMLElement
	contained: boolean
	onToggle?: (serverName: string) => void
}

export function McpServersDialog(props: McpServersDialogProps) {
	const [open, setOpen] = createSignal(false)

	return (
		<Show when={props.servers.length > 0}>
			<>
				<button
					class=":uno: inline-flex size-9 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
					type="button"
					title={t('chatbox.ui.mcp.button')}
					aria-label={t('chatbox.ui.mcp.button')}
					onClick={() => setOpen(true)}
				>
					<span class=":uno: i-lucide-plug size-4 shrink-0" />
				</button>
				<Show when={open()}>
					<Portal mount={props.mountEl}>
						<div
							class={[
								':uno: inset-0 z-[220] flex items-center justify-center bg-black/40 p-4',
								props.contained ? ':uno: absolute' : ':uno: fixed',
							].join(' ')}
							onPointerDown={(event) => {
								if (event.target === event.currentTarget) setOpen(false)
							}}
						>
							<div class=":uno: w-full max-w-sm rounded-4 border border-[var(--background-modifier-border)] bg-[var(--background-primary)] p-4 shadow-xl">
								<div class=":uno: flex items-center justify-between gap-3">
									<div class=":uno: text-base font-semibold text-[var(--text-normal)]">
										{t('chatbox.ui.mcp.title')}
									</div>
									<button
										class=":uno: text-sm text-[var(--text-muted)] hover:text-[var(--text-normal)]"
										type="button"
										onClick={() => setOpen(false)}
									>
										{t('chatbox.ui.actions.close')}
									</button>
								</div>
								<div class=":uno: mt-3 flex flex-col gap-2">
									<For each={props.servers}>
										{(server) => (
											<label class=":uno: flex cursor-pointer items-center gap-2 text-sm">
												<input
													type="checkbox"
													checked={!server.disabled}
													onChange={() => props.onToggle?.(server.name)}
												/>
												<span class=":uno: min-w-0 flex-1 truncate">
													{server.name}
												</span>
												<span class=":uno: shrink-0 text-xs text-[var(--text-muted)]">
													{server.connected
														? t('chatbox.ui.mcp.toolCount', {
																count: server.toolCount,
															})
														: t('chatbox.ui.mcp.notConnected')}
												</span>
											</label>
										)}
									</For>
								</div>
							</div>
						</div>
					</Portal>
				</Show>
			</>
		</Show>
	)
}
