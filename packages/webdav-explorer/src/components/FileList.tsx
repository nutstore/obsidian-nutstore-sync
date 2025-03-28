import { Notice } from 'obsidian'
import { createEffect, createSignal, For, Show } from 'solid-js'
import { type fs } from '../App'
import File from './File'
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

			const sortedItems = () =>
				items().sort((a, b) => {
					if (a.isDir === b.isDir) {
						return a.basename.localeCompare(b.basename, ['zh'])
					}
					if (a.isDir && !b.isDir) {
						return -1
					} else {
						return 1
					}
				})

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
				<For each={sortedItems()}>
					{(f) => (
						<Show when={f.isDir} fallback={<File name={f.basename} />}>
							<Folder
								name={f.basename}
								path={f.path}
								onClick={() => props.onClick(f)}
							/>
						</Show>
					)}
				</For>
			)
		},
	}
}
