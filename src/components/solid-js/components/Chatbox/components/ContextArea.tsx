import { For, Show } from 'solid-js'
import type { UserContextItem } from '~/chat/user-context'
import { t } from '../../../i18n'

function basename(path: string): string {
	return path.split('/').pop() ?? path
}

function FileIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			class="shrink-0"
		>
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<polyline points="14 2 14 8 20 8" />
		</svg>
	)
}

function FolderIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			class="shrink-0"
		>
			<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
		</svg>
	)
}

function TextIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			class="shrink-0"
		>
			<polyline points="4 7 4 4 20 4 20 7" />
			<line x1="9" y1="20" x2="15" y2="20" />
			<line x1="12" y1="4" x2="12" y2="20" />
		</svg>
	)
}

function ImageIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			class="shrink-0"
		>
			<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
			<circle cx="8.5" cy="8.5" r="1.5" />
			<path d="m21 15-5-5L5 21" />
		</svg>
	)
}

function RemoveButton(props: { onClick: () => void }) {
	return (
		<button
			class="ml-1 flex items-center justify-center size-3.5 rounded-full opacity-60 hover:opacity-100 !border-none !bg-transparent !shadow-none cursor-pointer p-0"
			type="button"
			title={t('chatbox.ui.actions.removeContextItem')}
			onClick={(e) => {
				e.stopPropagation()
				props.onClick()
			}}
		>
			<svg
				width="10"
				height="10"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<line x1="18" y1="6" x2="6" y2="18" />
				<line x1="6" y1="6" x2="18" y2="18" />
			</svg>
		</button>
	)
}

export function ContextArea(props: {
	items: UserContextItem[]
	onRemove?: (index: number) => void
}) {
	return (
		<Show when={props.items.length > 0}>
			<div class="mb-2 flex flex-wrap gap-1.5">
				<For each={props.items}>
					{(item, index) => (
						<div
							class="flex items-center gap-1 rounded-full border border-[var(--background-modifier-border)] bg-[var(--background-secondary)] px-2 py-0.5 text-xs text-[var(--text-muted)] max-w-48"
							title={
								item.type === 'selection'
									? item.selectedText
									: item.type === 'image'
										? item.name ||
											`${item.mimeType} ${Math.round(item.size / 1024)}KB`
										: item.path
							}
						>
							{item.type === 'folder' ? (
								<FolderIcon />
							) : item.type === 'selection' ? (
								<TextIcon />
							) : item.type === 'image' ? (
								<ImageIcon />
							) : (
								<FileIcon />
							)}
							<span class="truncate">
								{item.type === 'file' && basename(item.path)}
								{item.type === 'folder' && basename(item.path)}
								{item.type === 'image' &&
									(item.name ||
										`${item.mimeType.split('/')[1] || 'image'} ${Math.max(1, Math.round(item.size / 1024))}KB`)}
								{item.type === 'selection' &&
									`${basename(item.filePath)} L${item.range.from.line + 1}:${item.range.from.ch}-L${item.range.to.line + 1}:${item.range.to.ch}`}
							</span>
							<Show when={props.onRemove}>
								<RemoveButton onClick={() => props.onRemove!(index())} />
							</Show>
						</div>
					)}
				</For>
			</div>
		</Show>
	)
}
