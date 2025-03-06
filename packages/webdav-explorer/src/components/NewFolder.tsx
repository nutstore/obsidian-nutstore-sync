import { createSignal } from 'solid-js'
import { t } from '../i18n'

interface NewFolderProps {
	class?: string
	onConfirm: (name: string) => void
	onCancel: () => void
}

function NewFolder(props: NewFolderProps) {
	const [name, setName] = createSignal('')

	const className = () => `flex items-center gap-2 px-1 ${props.class}`

	return (
		<div class={className()}>
			<div class="i-custom:folder size-10"></div>
			<input
				type="text"
				class="flex-1"
				autofocus
				value={name()}
				onInput={(e) => setName(e.target.value)}
			/>
			<button onClick={() => props.onConfirm(name())}>{t('confirm')}</button>
			<button onClick={() => props.onCancel()}>{t('cancel')}</button>
		</div>
	)
}

export default NewFolder
