import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import type { ChatMcpServerOption } from '~/ai/chat/ui/types'
import { t } from '../../../i18n'

interface McpServersPopoverProps {
	servers: ChatMcpServerOption[]
	onToggle?: (serverName: string) => void
}

export function McpServersPopover(props: McpServersPopoverProps) {
	const [open, setOpen] = createSignal(false)
	let containerEl: HTMLDivElement | undefined

	createEffect(() => {
		if (!open()) {
			return
		}
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target
			if (!target || typeof target !== 'object' || !('nodeType' in target)) {
				return
			}
			if (containerEl?.contains(target as Node)) {
				return
			}
			setOpen(false)
		}
		const viewDoc = containerEl?.ownerDocument ?? document
		viewDoc.addEventListener('pointerdown', onPointerDown)
		onCleanup(() => viewDoc.removeEventListener('pointerdown', onPointerDown))
	})

	return (
		<Show when={props.servers.length > 0}>
			<div class=":uno: relative" ref={containerEl}>
				<button
					class=":uno: inline-flex size-9 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
					type="button"
					title={t('chatbox.ui.mcp.button')}
					aria-label={t('chatbox.ui.mcp.button')}
					onClick={() => setOpen((value) => !value)}
				>
					<span class=":uno: i-lucide-plug size-4 shrink-0" />
				</button>
				<Show when={open()}>
					<div class=":uno: absolute bottom-12 left-0 z-10 w-72 rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary)] p-3 shadow-lg">
						<div class=":uno: mb-2 text-xs text-[var(--text-muted)]">
							{t('chatbox.ui.mcp.title')}
						</div>
						<For each={props.servers}>
							{(server) => (
								<label class=":uno: flex cursor-pointer items-center gap-2 py-1 text-sm">
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
				</Show>
			</div>
		</Show>
	)
}
