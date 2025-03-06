import { createMediaQuery } from '@solid-primitives/media'
import path from 'path'
import { createSignal, Show } from 'solid-js'
import FileList, { FileStat } from './components/FileList'
import NewFolder from './components/NewFolder'
import { t } from './i18n'

type MaybePromise<T> = Promise<T> | T

export interface fs {
	ls: (path: string) => MaybePromise<FileStat[]>
	mkdirs: (path: string) => void
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
	// @ts-ignore
	const isSmall = createMediaQuery('(max-width: 767px)')

	function enter(path: string) {
		setStack((stack) => [...stack, path])
	}

	function pop() {
		setStack((stack) =>
			stack.length > 1 ? stack.slice(0, stack.length - 1) : stack,
		)
	}

	const SingleCol = () => (
		<div class="flex-1 flex flex-col overflow-y-auto scrollbar-hide">
			<Show when={showNewFolder()}>
				<NewFolder
					onCancel={() => setShowNewFolder(false)}
					onConfirm={async (name) => {
						const target = path.join(cwd() ?? '/', name)
						await props.fs.mkdirs(target)
						setShowNewFolder(false)
					}}
				/>
			</Show>
			<FileList
				fs={props.fs}
				path={cwd() ?? ''}
				onClick={(f) => enter(f.path)}
			/>
		</div>
	)

	// @ts-ignore
	const DoubleCol = () => {
		const fst = () => stack()?.at(-2)!
		const snd = () => stack()?.at(-1)!
		return (
			<div class="flex-1 flex overflow-auto">
				<div class="flex-1 overflow-y-auto scrollbar-hide">
					<FileList
						fs={props.fs}
						path={fst()}
						onClick={(f) => {
							setStack([...stack().slice(0, stack().length - 1), f.path])
						}}
					/>
				</div>
				<div class="h-full w-1px bg-[var(--interactive-accent)] mx-1"></div>
				<div class="flex-1 flex flex-col overflow-y-auto scrollbar-hide">
					<Show when={showNewFolder()}>
						<NewFolder
							onCancel={() => setShowNewFolder(false)}
							onConfirm={async (name) => {
								const target = path.join(snd() ?? '/', name)
								await props.fs.mkdirs(target)
								setShowNewFolder(false)
							}}
						/>
					</Show>
					<FileList fs={props.fs} path={snd()} onClick={(f) => enter(f.path)} />
				</div>
			</div>
		)
	}

	return (
		<div class="flex flex-col gap-4 h-50vh">
			{/* TODO: 2-cols style */}
			{/* <Show when={isSmall() || stack().length < 2} fallback={<DoubleCol />}>
				<SingleCol />
			</Show> */}
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
