import { createResource, createSignal, For, Show } from 'solid-js'
import {
	buildFileDiff,
	type FileDiff,
	type FileDiffHunk,
	type FileDiffLine,
	type FileDiffSegment,
} from '~/ai/chat/messages/file-diff'
import type { ReversibleToolOp } from '~/ai/chat/types'
import { t } from '../../i18n'
import { CollapsibleBlock } from './CollapsibleBlock'

const OPERATION_LABEL = {
	create: 'chatbox.ui.fileChanges.create',
	update: 'chatbox.ui.fileChanges.update',
	delete: 'chatbox.ui.fileChanges.delete',
} as const

function computeStats(diff: FileDiff): { added: number; removed: number } {
	let added = 0
	let removed = 0
	for (const hunk of diff.hunks ?? []) {
		for (const line of hunk.lines) {
			if (line.kind === 'add') added += 1
			else if (line.kind === 'remove') removed += 1
		}
	}
	return { added, removed }
}

function lineBackgroundClass(kind: FileDiffLine['kind']): string {
	if (kind === 'add') {
		return ':uno: bg-[color-mix(in_srgb,var(--color-green)_15%,transparent)]'
	}
	if (kind === 'remove') {
		return ':uno: bg-[color-mix(in_srgb,var(--color-red)_15%,transparent)]'
	}
	return ''
}

function segmentHighlightClass(
	segment: FileDiffSegment,
	kind: FileDiffLine['kind'],
): string | undefined {
	if (!segment.changed) return undefined
	return kind === 'add'
		? ':uno: py-1 bg-[color-mix(in_srgb,var(--color-green)_45%,var(--background-secondary))]'
		: ':uno: py-1 bg-[color-mix(in_srgb,var(--color-red)_45%,var(--background-secondary))]'
}

function DiffSegment(props: {
	segment: FileDiffSegment
	lineKind: FileDiffLine['kind']
}) {
	return (
		<span
			class={segmentHighlightClass(props.segment, props.lineKind)}
			style={{
				'-webkit-box-decoration-break': 'clone',
				'box-decoration-break': 'clone',
			}}
		>
			{props.segment.text}
		</span>
	)
}

function DiffLine(props: { line: FileDiffLine }) {
	return (
		<div
			class={`:uno: grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] overflow-hidden px-1 ${lineBackgroundClass(props.line.kind)}`}
		>
			<span class=":uno: select-none text-right text-[var(--text-faint)]">
				{props.line.kind === 'remove'
					? (props.line.oldLine ?? '')
					: (props.line.newLine ?? '')}
			</span>
			<span class=":uno: min-w-0 select-text whitespace-pre-wrap break-words pr-2">
				{props.line.kind === 'add'
					? '+'
					: props.line.kind === 'remove'
						? '-'
						: ' '}
				<Show when={props.line.segments} fallback={props.line.text}>
					<For each={props.line.segments}>
						{(segment) => (
							<DiffSegment segment={segment} lineKind={props.line.kind} />
						)}
					</For>
				</Show>
			</span>
		</div>
	)
}

function DiffHunk(props: { hunk: FileDiffHunk }) {
	return (
		<div class=":uno: font-mono text-xs leading-5">
			<div class=":uno: bg-[var(--background-secondary-alt)] px-4 text-[var(--text-muted)]">
				@@ -{props.hunk.oldStart},{props.hunk.oldCount} +{props.hunk.newStart},
				{props.hunk.newCount} @@
			</div>
			<For each={props.hunk.lines}>{(line) => <DiffLine line={line} />}</For>
		</div>
	)
}

function FileChangeSummary(props: {
	diff: FileDiff
	onOpenFile?: (vaultPath: string, line?: number) => Promise<void> | void
}) {
	const operationLabel = () => t(OPERATION_LABEL[props.diff.operation])
	const openLine = () =>
		props.diff.hunks?.[0]?.lines.find((line) => line.kind === 'add')?.newLine ??
		props.diff.hunks?.[0]?.newStart
	return (
		<div class=":uno: flex min-w-0 items-center gap-2">
			<span
				class=":uno: flex size-5 shrink-0 items-center justify-center text-[var(--text-muted)]"
				title={operationLabel()}
				aria-label={operationLabel()}
				role="img"
			>
				<span
					class=":uno: i-lucide-file-diff size-5 shrink-0"
					aria-hidden="true"
				/>
			</span>
			<button
				type="button"
				class=":uno: min-w-0 flex-1 cursor-pointer truncate text-left text-[var(--link-color)] hover:underline !border-none !bg-transparent !p-0 !shadow-none"
				onClick={(event) => {
					event.stopPropagation()
					void props.onOpenFile?.(props.diff.vaultPath, openLine())
				}}
			>
				{props.diff.vaultPath}
			</button>
		</div>
	)
}

function FileChangeStats(props: { diff: FileDiff }) {
	const stats = () => computeStats(props.diff)
	return (
		<Show when={props.diff.hunks}>
			<span class=":uno: shrink-0 text-xs">
				<span class=":uno: text-[var(--color-green)]">+{stats().added}</span>{' '}
				<span class=":uno: text-[var(--color-red)]">-{stats().removed}</span>
			</span>
		</Show>
	)
}

function FileChange(props: {
	change: ReversibleToolOp
	onOpenFile?: (vaultPath: string, line?: number) => Promise<void> | void
}) {
	const [diff] = createResource(() => props.change, buildFileDiff)
	const [open, setOpen] = createSignal(false)
	return (
		<Show when={diff()} keyed>
			{(value) => (
				<CollapsibleBlock
					summary={
						<FileChangeSummary diff={value} onOpenFile={props.onOpenFile} />
					}
					headerActions={<FileChangeStats diff={value} />}
					open={open()}
					onOpenChange={setOpen}
				>
					<Show when={value.binary}>
						<div class=":uno: rounded-3 px-2 py-1.5 text-xs text-[var(--text-muted)]">
							{t('chatbox.ui.fileChanges.binary')}
						</div>
					</Show>
					<div class=":uno: overflow-hidden rounded-3 rounded-t-6">
						<For each={value.hunks}>{(hunk) => <DiffHunk hunk={hunk} />}</For>
					</div>
				</CollapsibleBlock>
			)}
		</Show>
	)
}

export function FileChangesBlock(props: {
	changes?: ReversibleToolOp[]
	onOpenFile?: (vaultPath: string, line?: number) => Promise<void> | void
}) {
	return (
		<Show when={props.changes?.length}>
			<div class=":uno: mt-2">
				<div class=":uno: flex flex-col gap-2">
					<For each={props.changes}>
						{(change) => (
							<FileChange change={change} onOpenFile={props.onOpenFile} />
						)}
					</For>
				</div>
			</div>
		</Show>
	)
}
