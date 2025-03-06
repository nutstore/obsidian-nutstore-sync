import { Notice } from 'obsidian'
import { createEffect, createSignal, For } from 'solid-js'
import { type fs } from '../App'
import Folder from './Folder'

export interface FileStat {
	path: string
	basename: string
	isDir: boolean
}

export interface FileListProps {
	path: string
	fs: fs
	onClick: (file: FileStat) => void
}

function FileList(props: FileListProps) {
	const [items, setItems] = createSignal<FileStat[]>([])

	const folders = () =>
		items()
			.filter((item) => item.isDir)
			.sort((a, b) => a.basename.localeCompare(b.basename, ['zh']))

	createEffect(refresh)

	async function refresh() {
		try {
			const items = await props.fs.ls(props.path)
			setItems(items)
		} catch (e) {
			if (e instanceof Error) {
				new Notice(e.message)
			}
		}
	}
	return (
		<For each={folders()}>
			{(folder) => (
				<Folder
					name={folder.basename}
					path={folder.path}
					onClick={() => props.onClick(folder)}
				/>
			)}
		</For>
	)
}

export default FileList
