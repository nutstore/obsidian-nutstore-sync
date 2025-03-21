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

export function createFileList() {
	const [version, setVersion] = createSignal(0)
	return {
		refresh() {
			setVersion((v) => ++v)
		},
		FileList(props: FileListProps) {
			const [items, setItems] = createSignal<FileStat[]>([])

			const folders = () =>
				items()
					.filter((item) => item.isDir)
					.sort((a, b) => a.basename.localeCompare(b.basename, ['zh']))

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

			createEffect(async () => {
				if (version() === 0) {
					await refresh()
					return
				}
				setVersion(0)
			})

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
		},
	}
}
