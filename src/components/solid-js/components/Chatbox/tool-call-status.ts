import type { ChatDisplayToolCallBlock } from '~/ai/chat/types'
import { t } from '../../i18n'
import { formatDuration } from './utils'

export function timingDuration(
	timing: ChatDisplayToolCallBlock['timing'],
	now: number,
) {
	if (!timing) return
	return formatDuration((timing.finishedAt ?? now) - timing.startedAt)
}

export function toolStatusVisual(
	toolCall: ChatDisplayToolCallBlock['toolCall'],
) {
	switch (toolCall.state) {
		case 'output-available':
			return successVisual()
		case 'output-error':
			return failedVisual()
		case 'output-denied':
			return cancelledVisual(t('chatbox.ui.states.toolDenied'))
		case 'approval-requested':
			return waitingVisual(t('chatbox.ui.states.toolWaitingApproval'))
		case 'approval-responded':
			return toolCall.approval.approved
				? runningVisual()
				: cancelledVisual(t('chatbox.ui.states.toolDenied'))
		default:
			return runningVisual()
	}
}

export function runningVisual() {
	return {
		label: t('chatbox.ui.states.running'),
		iconClass:
			':uno: i-lucide-loader-circle animate-spin text-[var(--interactive-accent)]',
	}
}

export function waitingVisual(
	label: string,
	icon = ':uno: i-lucide-hourglass',
) {
	return { label, iconClass: `${icon} text-[var(--color-yellow)]` }
}

export function successVisual() {
	return {
		label: t('chatbox.ui.states.completed'),
		iconClass: ':uno: i-lucide-circle-check text-[var(--color-green)]',
	}
}

export function failedVisual() {
	return {
		label: t('chatbox.ui.states.failed'),
		iconClass: ':uno: i-lucide-circle-x text-[var(--text-error)]',
	}
}

export function cancelledVisual(label: string) {
	return {
		label,
		iconClass: ':uno: i-lucide-circle-slash text-[var(--text-muted)]',
	}
}
