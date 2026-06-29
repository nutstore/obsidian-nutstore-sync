import { For, Show } from 'solid-js'
import type { UserContextItem } from '~/ai/chat/context/user-context'
import { t } from '../../../i18n'

function basename(path: string): string {
	return path.split('/').pop() ?? path
}

function getExtension(path: string): string {
	const parts = path.split('.')
	if (parts.length < 2) return ''
	return parts[parts.length - 1].toLowerCase()
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
const TEXT_EXTENSIONS = new Set(['txt', 'text', 'log'])
const IMAGE_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'bmp',
	'svg',
	'avif',
	'tiff',
])
const CODE_EXTENSIONS = new Set([
	'js',
	'ts',
	'jsx',
	'tsx',
	'json',
	'css',
	'scss',
	'html',
	'xml',
	'yaml',
	'yml',
	'toml',
	'py',
	'go',
	'rs',
	'java',
	'c',
	'cpp',
	'h',
	'sh',
	'rb',
	'php',
	'vue',
	'svelte',
])
const DATA_EXTENSIONS = new Set(['csv', 'tsv', 'db', 'sqlite'])
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'rar', '7z'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm'])

function vaultFileIconClass(path: string): string {
	const ext = getExtension(path)
	if (MARKDOWN_EXTENSIONS.has(ext)) return 'i-lucide-file-text'
	if (TEXT_EXTENSIONS.has(ext)) return 'i-lucide-file-text'
	if (IMAGE_EXTENSIONS.has(ext)) return 'i-lucide-file-image'
	if (CODE_EXTENSIONS.has(ext)) return 'i-lucide-file-code'
	if (DATA_EXTENSIONS.has(ext)) return 'i-lucide-file-spreadsheet'
	if (ARCHIVE_EXTENSIONS.has(ext)) return 'i-lucide-file-archive'
	if (AUDIO_EXTENSIONS.has(ext)) return 'i-lucide-file-audio'
	if (VIDEO_EXTENSIONS.has(ext)) return 'i-lucide-file-video'
	if (ext === 'pdf') return 'i-lucide-file-text'
	if (ext === 'canvas') return 'i-lucide-layout-dashboard'
	return 'i-lucide-file'
}

function contextIconClass(item: UserContextItem): string {
	if (item.type === 'vault-path') {
		return item.kind === 'folder'
			? 'i-lucide-folder'
			: vaultFileIconClass(item.path)
	}
	if (item.type === 'selection') return 'i-lucide-text-select'
	if (item.type === 'image') return 'i-lucide-image'
	if (item.type === 'pending-context') return 'i-lucide-loader-circle'
	if (item.type === 'file') return vaultFileIconClass(item.filename)
	return 'i-lucide-file'
}

function ContextIcon(props: { item: UserContextItem }) {
	return (
		<span
			class={`${contextIconClass(props.item)} shrink-0${
				props.item.type === 'pending-context' ? ' animate-spin' : ''
			}`}
		/>
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
			<span class="i-lucide-x size-2.5 shrink-0" />
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
									: item.type === 'file'
										? `${item.filename} ${Math.max(1, Math.round(item.size / 1024))}KB`
										: item.type === 'image'
											? item.name ||
												`${item.mimeType} ${Math.round(item.size / 1024)}KB`
											: item.type === 'pending-context'
												? item.placeholder ||
													t('chatbox.ui.states.loadingContextItem')
												: item.path
							}
						>
							<ContextIcon item={item} />
							<span class="truncate">
								{item.type === 'vault-path' && basename(item.path)}
								{item.type === 'file' && item.filename}
								{item.type === 'image' &&
									(item.name ||
										`${item.mimeType.split('/')[1] || 'image'} ${Math.max(1, Math.round(item.size / 1024))}KB`)}
								{item.type === 'pending-context' &&
									(item.placeholder ||
										t('chatbox.ui.states.loadingContextItem'))}
								{item.type === 'selection' &&
									`${basename(item.filePath)} L${item.range.from.line + 1}:${item.range.from.ch + 1}-L${item.range.to.line + 1}:${item.range.to.ch + 1}`}
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
