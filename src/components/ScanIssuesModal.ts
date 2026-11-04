import { App, Modal, Notice, Setting } from 'obsidian'
import { escapeRegExp, sortBy } from 'es-toolkit'
import i18n from '~/i18n'
import {
	mountScanIssueList,
	type ScanIssueListController,
	type ScanIssueRow,
} from './solid-js'
import type { ScanIssue } from '~/sync/scope'
import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import { describeThrownValue } from '~/utils/error-inspection'

/**
 * Host errors quote the absolute path of the failing item, which the row already
 * shows. Drop that quotation so the cause reads as "what went wrong", and fall
 * back to the raw message when nothing else remains.
 */
export function describeScanCause({ path, cause }: ScanIssue): string {
	const message = describeThrownValue(cause).trim()
	const escaped = escapeRegExp(path)
	// A quoted absolute path may contain spaces; an unquoted one ends at whitespace.
	const quoted = new RegExp(`['"][^'"]*${escaped}['"]|\\S*${escaped}`, 'g')
	const brief = message
		.replace(quoted, '')
		.replace(/[\s,:;]+$/, '')
		.trim()
	return brief || message
}

const toRow = (issue: ScanIssue): ScanIssueRow => ({
	path: issue.path,
	step: i18n.t(`scanIssues.operations.${issue.operation}`),
	cause: describeScanCause(issue),
})

const formatRows = (rows: readonly ScanIssueRow[]) =>
	rows.map(({ path, step, cause }) => [path, step, cause].join('\t')).join('\n')

/** Tab-separated `path / step / cause` lines, ready to paste into a note or report. */
export function formatScanIssues(issues: readonly ScanIssue[]): string {
	return formatRows(issues.map(toRow))
}

/**
 * Lists in-scope paths that could not be scanned in the last sync. Rule-excluded
 * paths never become issues, so everything shown here was meant to sync but was
 * left untouched on both devices until the next successful scan.
 */
export default class ScanIssuesModal extends Modal {
	/** Sorted by path: scan order depends on I/O timing, the list should not. */
	private rows: ScanIssueRow[]
	private list?: ScanIssueListController
	private intro?: HTMLElement

	constructor(app: App, issues: readonly ScanIssue[]) {
		super(app)
		this.rows = ScanIssuesModal.toRows(issues)
	}

	private static toRows(issues: readonly ScanIssue[]) {
		return sortBy(issues, [(issue) => issue.path]).map(toRow)
	}

	/** Refresh a modal that is still on screen when another sync ends. */
	update(issues: readonly ScanIssue[]) {
		this.rows = ScanIssuesModal.toRows(issues)
		this.list?.update({ items: this.rows })
		if (this.intro) this.intro.textContent = this.introText()
	}

	private introText() {
		return i18n.t('scanIssues.instruction', { count: this.rows.length })
	}

	onOpen() {
		addClassTokens(this.modalEl, 'scan-issues-modal', 'mod-lg')
		this.setTitle(i18n.t('scanIssues.title'))
		const { contentEl } = this
		contentEl.empty()

		this.intro = contentEl.createEl('p', {
			cls: 'scan-issues-intro',
			text: this.introText(),
		})
		this.list = mountScanIssueList(
			contentEl.createDiv({ cls: 'scan-issues-mount' }),
			{ items: this.rows },
		)

		new Setting(contentEl)
			.setClass('scan-issues-actions')
			.addButton((button) =>
				button
					.setButtonText(i18n.t('scanIssues.copy'))
					.onClick(() => this.copyAll()),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('scanIssues.close'))
					.setCta()
					.onClick(() => this.close()),
			)
	}

	private async copyAll() {
		try {
			await navigator.clipboard.writeText(formatRows(this.rows))
			new Notice(i18n.t('scanIssues.copied', { count: this.rows.length }))
		} catch {
			new Notice(i18n.t('scanIssues.copyFailed'))
		}
	}

	onClose() {
		this.list?.destroy()
		this.list = undefined
		this.intro = undefined
		removeClassTokens(this.modalEl, 'scan-issues-modal', 'mod-lg')
		this.contentEl.empty()
	}
}
