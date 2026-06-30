import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

interface HighlightRange {
	from: number
	to: number
}

const setHighlightEffect = StateEffect.define<HighlightRange | null>()

const highlightMark = Decoration.mark({
	class: 'nutstore-chatbox-selection-highlight',
})

const highlightField = StateField.define<HighlightRange | null>({
	create: () => null,
	update(value, tr) {
		let next = value
		if (next && !tr.changes.empty) {
			const mappedFrom = tr.changes.mapPos(next.from, 1)
			const mappedTo = tr.changes.mapPos(next.to, -1)
			next = normalizeRange(tr.state.doc.length, mappedFrom, mappedTo)
		}
		for (const effect of tr.effects) {
			if (!effect.is(setHighlightEffect)) continue
			next = effect.value
				? normalizeRange(
						tr.state.doc.length,
						effect.value.from,
						effect.value.to,
					)
				: null
		}
		return next
	},
	provide: (field) =>
		EditorView.decorations.from(field, (range) =>
			range
				? Decoration.set([highlightMark.range(range.from, range.to)])
				: Decoration.none,
		),
})

const highlightTheme = EditorView.baseTheme({
	'.nutstore-chatbox-selection-highlight': {
		backgroundColor: 'var(--text-selection)',
		borderRadius: '2px',
	},
})

const highlightExtension: Extension = [highlightField, highlightTheme]

function normalizeRange(
	docLength: number,
	from: number,
	to: number,
): HighlightRange | null {
	const clampedFrom = Math.max(0, Math.min(from, docLength))
	const clampedTo = Math.max(0, Math.min(to, docLength))
	if (clampedFrom === clampedTo) return null
	return {
		from: Math.min(clampedFrom, clampedTo),
		to: Math.max(clampedFrom, clampedTo),
	}
}

function isInstalled(view: EditorView) {
	return view.state.field(highlightField, false) !== undefined
}

function buildEffects(
	view: EditorView,
	range: HighlightRange | null,
): StateEffect<unknown>[] {
	const effects: StateEffect<unknown>[] = []
	if (!range) {
		if (isInstalled(view)) {
			effects.push(setHighlightEffect.of(null))
		}
		return effects
	}
	const normalized = normalizeRange(view.state.doc.length, range.from, range.to)
	if (!normalized) {
		if (isInstalled(view)) {
			effects.push(setHighlightEffect.of(null))
		}
		return effects
	}
	if (!isInstalled(view)) {
		effects.push(StateEffect.appendConfig.of(highlightExtension))
	}
	effects.push(setHighlightEffect.of(normalized))
	return effects
}

export function showChatboxSelectionHighlight(
	view: EditorView,
	from: number,
	to: number,
) {
	const effects = buildEffects(view, { from, to })
	if (effects.length > 0) {
		view.dispatch({ effects })
	}
}

export function hideChatboxSelectionHighlight(view: EditorView) {
	const effects = buildEffects(view, null)
	if (effects.length > 0) {
		view.dispatch({ effects })
	}
}
