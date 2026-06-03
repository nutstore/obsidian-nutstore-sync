import { Show, createSignal, onCleanup } from 'solid-js'
import { t } from '../i18n'

export function CopyButton(props: { getText: () => string }) {
	const [copied, setCopied] = createSignal(false)
	let timer: ReturnType<typeof setTimeout>

	function handleCopy() {
		void navigator.clipboard.writeText(props.getText()).then(() => {
			setCopied(true)
			clearTimeout(timer)
			timer = setTimeout(() => setCopied(false), 2000)
		})
	}

	onCleanup(() => clearTimeout(timer))

	return (
		<button
			class="cursor-pointer p-1 size-5 text-[var(--text-muted)] hover:text-[var(--text-normal)] !border-none !bg-transparent !shadow-none"
			type="button"
			title={copied() ? t('copied') : t('copy')}
			onClick={handleCopy}
		>
			<Show
				when={copied()}
				fallback={
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
						<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
					</svg>
				}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<polyline points="20 6 9 17 4 12" />
				</svg>
			</Show>
		</button>
	)
}
