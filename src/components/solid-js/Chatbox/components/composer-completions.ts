import {
	closeCompletion,
	pickedCompletion,
	type CompletionContext,
	type CompletionResult,
} from '@codemirror/autocomplete'

export interface ComposerCommand {
	name: string
	label: string
	description?: string
	run: () => void
}

/** Triggers require a token boundary so email addresses and paths stay ordinary text. */
export function composerTrigger(text: string) {
	const mention = /(?:^|\s)@([^@\n]*)$/u.exec(text)
	if (mention)
		return {
			kind: 'mention' as const,
			query: mention[1],
			from: text.length - mention[1].length - 1,
		}
	const command = /^\/([^\s/]*)$/u.exec(text)
	if (command) return { kind: 'command' as const, query: command[1], from: 0 }
	return null
}

export function composerCompletions(options: {
	paths: () => string[]
	mention: (path: string) => void
	commands: () => ComposerCommand[]
}) {
	return (context: CompletionContext): CompletionResult | null => {
		if (!context.state.selection.main.empty) return null
		const trigger = composerTrigger(context.state.sliceDoc(0, context.pos))
		if (!trigger) return null
		const query = trigger.query.toLocaleLowerCase()
		const entries: {
			label: string
			displayLabel?: string
			detail?: string
			run: () => void
		}[] =
			trigger.kind === 'mention'
				? options
						.paths()
						.filter((path) => path.toLocaleLowerCase().includes(query))
						.sort()
						.slice(0, 100)
						.map((path) => ({
							label: path,
							displayLabel: path.slice(path.lastIndexOf('/') + 1),
							detail: path.includes('/')
								? path.slice(0, path.lastIndexOf('/'))
								: undefined,
							run: () => options.mention(path),
						}))
				: options
						.commands()
						.filter((command) =>
							`${command.name} ${command.label}`
								.toLocaleLowerCase()
								.includes(query),
						)
						.map((command) => ({
							label: `/${command.name}`,
							detail: command.description ?? command.label,
							run: command.run,
						}))
		return {
			from: trigger.from,
			filter: false,
			options: entries.map((entry) => ({
				label: entry.label,
				displayLabel: entry.displayLabel,
				detail: entry.detail,
				type:
					trigger.kind === 'command'
						? 'command'
						: entry.label.endsWith('.excalidraw.md')
							? 'drawing'
							: 'file',
				apply(view, completion, from, to) {
					view.dispatch({
						changes: { from, to, insert: '' },
						annotations: pickedCompletion.of(completion),
					})
					closeCompletion(view)
					entry.run()
				},
			})),
		}
	}
}
