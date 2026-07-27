import { createSignal } from 'solid-js'
import { t } from '../../../i18n'

interface NewFolderProps {
	class?: string
	onConfirm: (name: string) => void
	onCancel: () => void
}

function NewFolder(props: NewFolderProps) {
	const [name, setName] = createSignal('')

	const className = () => `:uno: flex items-center gap-2 px-1 ${props.class}`

	return (
		<div class={className()}>
			<div class=":uno: i-custom:folder size-10" />
			<input
				type="text"
				class=":uno: flex-1"
				autofocus
				value={name()}
				onInput={(e) => setName(e.target.value)}
			/>
			<button onClick={() => props.onConfirm(name())}>
				{t('webdavExplorer.actions.confirm')}
			</button>
			<button onClick={() => props.onCancel()}>
				{t('webdavExplorer.actions.cancel')}
			</button>
		</div>
	)
}

export default NewFolder
