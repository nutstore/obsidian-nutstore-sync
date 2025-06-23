import { Notice } from 'obsidian'
import path from 'path'
import { createSignal, Show } from 'solid-js'
import { createFileList, FileStat } from './components/FileList'
import NewFolder from './components/NewFolder'
import { t } from './i18n'

type MaybePromise<T> = Promise<T> | T

export interface fs {
	ls: (path: string) => MaybePromise<FileStat[]>
	mkdirs: (path: string) => MaybePromise<void>
}

export interface AppProps {
	fs: fs
	onConfirm: (path: string) => void
	onClose: () => void
}

function App(props: AppProps) {
	const [stack, setStack] = createSignal<string[]>(['/'])
	const [showNewFolder, setShowNewFolder] = createSignal(false)
	const cwd = () => stack().at(-1)

	function enter(path: string) {
		setStack((stack) => [...stack, path])
	}

	function pop() {
		setStack((stack) =>
			stack.length > 1 ? stack.slice(0, stack.length - 1) : stack,
		)
	}

	const SingleCol = () => {
		const list = createFileList()
		return (
			<div class="flex-1 flex flex-col overflow-y-auto scrollbar-hide">
				<Show when={showNewFolder()}>
					<NewFolder
						class="mt-1"
						onCancel={() => setShowNewFolder(false)}
						onConfirm={async (name) => {
							const target = path.join(cwd() ?? '/', name)
							await Promise.resolve(props.fs.mkdirs(target))
								.then(() => {
									setShowNewFolder(false)
									list.refresh()
								})
								.catch((e) => {
									if (e instanceof Error) {
										new Notice(e.message)
									}
								})
						}}
					/>
				</Show>
				<list.FileList
					fs={props.fs}
					path={cwd() ?? ''}
					onClick={(f) => enter(f.path)}
				/>
			</div>
		)
	}

	return (
		<div class="flex flex-col gap-4 h-50vh">
			<SingleCol />
			<div class="flex gap-2 text-xs">
				<span>{t('currentPath')}:</span>
				<span class="break-all">{cwd() ?? '/'}</span>
			</div>
			<div class="flex items-center gap-2">
				<button onClick={pop}>{t('goBack')}</button>
				<a class="no-underline" onClick={() => setShowNewFolder(true)}>
					{t('newFolder')}
				</a>
				<div class="flex-1"></div>
				<button onClick={props.onClose}>{t('cancel')}</button>
				<button onclick={() => props.onConfirm(cwd() ?? '/')}>
					{t('confirm')}
				</button>
			</div>
		</div>
	)
}

export default App
