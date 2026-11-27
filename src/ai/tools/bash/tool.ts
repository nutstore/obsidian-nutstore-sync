import { tool } from 'ai'
import { idAgent } from 'id-agent'
import * as z from 'zod/mini'
import {
	AGENTS_MOUNT_POINT,
	APPS_MOUNT_POINT,
	BASH_TMP_MOUNT_POINT,
	BUILTIN_SKILLS_MOUNT_POINT,
	SETTINGS_FILE_PATH,
	VAULT_MOUNT_POINT,
} from '~/ai/tools/bash/mount-points'
import { execVaultBash } from '~/ai/tools/bash/runtime'
import { writeBashTmpText } from '~/ai/tools/bash/tmp-fs'
import { normalizeVirtualPath } from '~/ai/tools/bash/virtual-path'
import { withPermissionPurpose } from '~/ai/tools/permission-guard'
import {
	appDep,
	fileSystemManagerDep,
	getSettingsSnapshotDep,
	permissionGuardDep,
	readTrackerDep,
	recordMetadataDep,
	updateSettingsDep,
} from '~/ai/tools/tool-context'
import i18n from '~/i18n'
import { booleanValue, textValue } from '../shared'

const MAX_INLINE_BASH_OUTPUT_CHARS = 20 * 1024

export const bashTool = tool({
	description: [
		'Run a browser-sandboxed bash subset over the virtual filesystem. Not a host Linux shell: node, python, xxd, some flags, and OS paths (/bin, /dev, /etc, /home, /proc, /usr, /var, bare /tmp) do not exist — redirecting like "> /dev/null" or "> /tmp/x" creates real vault files.',
		`Mounts (use vault-relative paths for notes, absolute paths for mounts): ${VAULT_MOUNT_POINT} is the Obsidian vault root (writes are real synced user data — keep only intended content); ${AGENTS_MOUNT_POINT} is hidden plugin/user-Skill data (inspect only when needed); ${APPS_MOUNT_POINT}/<appId>/ holds App source files (validated and hot-reloaded on save; data.json, logs.jsonl, state.json are host-owned read-only; run "app open [appId]" to show); ${BUILTIN_SKILLS_MOUNT_POINT} is read-only bundled Skills; ${BASH_TMP_MOUNT_POINT} is the only scratch folder (still real, hidden, and synced — delete temp files when done); ${SETTINGS_FILE_PATH} is virtual live settings JSON (whitelist only, never credentials; write complete valid JSON via jq or full rewrite to validate and apply).`,
		'Supported commands: ls, cat, rg, jq, sed, awk, od, gzip, gunzip, zcat, zip, unzip (store/deflate only; no encrypted or Zip64), mkdir, mv, cp, and rm.',
		'Globs enumerate live directories; dot-prefixed entries need a dot-prefixed pattern or "shopt -s dotglob". When a glob or rg finds nothing, list the parent directory or read the explicit path before concluding a file is missing.',
		"purpose (<=120 chars): plain-language summary in the user's language of what this command does and why — no code, markdown, newlines, or shell syntax.",
	].join(' '),
	inputSchema: z.object({
		purpose: textValue('purpose').check(
			z.maxLength(
				120,
				i18n.t('chatbox.errors.toolFieldTooLong', { field: 'purpose' }),
			),
		),
		script: textValue('script'),
		cwd: z._default(z.string(), VAULT_MOUNT_POINT),
		stdin: z.optional(z.string()),
		rawScript: z._default(booleanValue('rawScript'), false),
	}),
	contextSchema: z.object({
		app: appDep,
		fileSystemManager: fileSystemManagerDep,
		permissionGuard: permissionGuardDep,
		readTracker: readTrackerDep,
		recordMetadata: recordMetadataDep,
		getSettingsSnapshot: getSettingsSnapshotDep,
		updateSettings: updateSettingsDep,
	}),
	outputSchema: z.string(),
	execute: async (params, { context, toolCallId, abortSignal }) => {
		const {
			app,
			fileSystemManager,
			permissionGuard,
			readTracker,
			recordMetadata,
			getSettingsSnapshot,
			updateSettings,
		} = context
		const cwd = normalizeVirtualPath(params.cwd || VAULT_MOUNT_POINT)

		const result = await execVaultBash(app, params.script, {
			cwd,
			signal: abortSignal,
			stdin: params.stdin,
			rawScript: params.rawScript,
			permissionGuard: withPermissionPurpose(permissionGuard, params.purpose),
			onRead: readTracker?.markRead.bind(readTracker),
			getSettingsSnapshot,
			updateSettings,
			fileSystemManager,
		})
		const output = `${result.stdout}\n\n${result.stderr}`
		recordMetadata?.(toolCallId, {
			reversibleOps: result.reversibleOps,
		})
		if (output.length > MAX_INLINE_BASH_OUTPUT_CHARS) {
			const outputPath = `${BASH_TMP_MOUNT_POINT}/${idAgent({ prefix: 'bash', words: 3 })}.txt`
			await writeBashTmpText(app, outputPath, output)
			return `Bash output was too long to return inline (${output.length} characters). The complete output was written to ${outputPath}. Use bash commands such as rg, sed, head, or tail to inspect it in smaller chunks.`
		}

		return output
	},
	toModelOutput: ({ output }) => ({
		type: 'text',
		value: output,
	}),
})
