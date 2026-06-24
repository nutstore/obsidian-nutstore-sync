import { Show, createMemo } from 'solid-js'

export interface ContextRingProps {
	/** Tokens already consumed in the current context window. */
	used: number
	/** Total context window size (tokens) for the active model. */
	total: number
	/** Diameter in px. Defaults to 18. */
	size?: number
	/** Stroke width in px. Defaults to 3. */
	stroke?: number
	/** Optional accessible title for the SVG. */
	title?: string
}

function clampRatio(value: number) {
	if (!Number.isFinite(value)) return 0
	if (value < 0) return 0
	if (value > 1) return 1
	return value
}

/**
 * Picks a stroke color for the given usage ratio.
 *   0.00 – 0.50  green
 *   0.50 – 0.80  yellow
 *   0.80 – 1.00  red
 */
function colorForUsage(ratio: number): string {
	if (ratio >= 0.8) return 'var(--text-error, #e53935)'
	if (ratio >= 0.5) return 'var(--text-warning, #f0ad4e)'
	return 'var(--text-success, #4caf50)'
}

/**
 * A compact SVG ring chart that visualises how much of the model's context
 * window has been consumed. The arc grows clockwise and the stroke color
 * transitions green → yellow → red as the window fills up.
 */
export function ContextRing(props: ContextRingProps) {
	const ratio = createMemo(() => {
		if (!props.total || props.total <= 0) return 0
		return clampRatio(props.used / props.total)
	})
	const size = createMemo(() => props.size ?? 18)
	const stroke = createMemo(() => props.stroke ?? 3)

	const radius = createMemo(() => (size() - stroke()) / 2)
	const circumference = createMemo(() => 2 * Math.PI * radius())
	const dashOffset = createMemo(() => circumference() * (1 - ratio()))
	const color = createMemo(() => colorForUsage(ratio()))
	const center = createMemo(() => size() / 2)

	return (
		<svg
			width={size()}
			height={size()}
			viewBox={`0 0 ${size()} ${size()}`}
			class="context-ring shrink-0"
			role="img"
			aria-label={props.title}
		>
			<Show when={props.title}>
				<title>{props.title}</title>
			</Show>
			<circle
				cx={center()}
				cy={center()}
				r={radius()}
				fill="none"
				stroke="var(--background-modifier-border, rgba(125,125,125,0.35))"
				stroke-width={stroke()}
			/>
			<circle
				cx={center()}
				cy={center()}
				r={radius()}
				fill="none"
				stroke={color()}
				stroke-width={stroke()}
				stroke-linecap="round"
				stroke-dasharray={`${circumference()} ${circumference()}`}
				stroke-dashoffset={dashOffset()}
				transform={`rotate(-90 ${center()} ${center()})`}
			/>
		</svg>
	)
}
