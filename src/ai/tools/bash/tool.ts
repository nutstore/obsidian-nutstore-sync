import { posix as pathPosix } from 'path-browserify'
import { idAgent } from 'id-agent'
import { tool } from 'ai'
import { z } from 'zod/mini'
import {
	AGENTS_MOUNT_POINT,
	BUILTIN_SKILLS_MOUNT_POINT,
	execVaultBash,
	SETTINGS_MOUNT_POINT,
	VAULT_MOUNT_POINT,
} from '~/ai/tools/bash/runtime'
import { BASH_TMP_MOUNT_POINT, writeBashTmpText } from '~/ai/tools/bash/tmp-fs'
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

function isAllowedBashCwd(pathValue: string) {
	const normalized = pathPosix.normalize(
		pathPosix.resolve('/', pathValue || '/'),
	)
	return normalized.startsWith('/')
}

export const bashTool = tool({
	description: [
		`Execute a browser-based bash subset against a virtual filesystem where the Obsidian vault is rooted at ${VAULT_MOUNT_POINT}, agent data is available at ${AGENTS_MOUNT_POINT}, built-in Skills are read-only under ${BUILTIN_SKILLS_MOUNT_POINT}, and plugin settings are editable at ${SETTINGS_MOUNT_POINT}/settings.json.`,
		'This is not the host shell: node, python, xxd, and some command flags are unavailable.',
		'Prefer supported commands such as ls, cat, rg, jq, sed, awk, od, gzip, gunzip, zcat, zip, unzip, mkdir, mv, cp, and rm. zip and unzip support standard store/deflate archives, but not encrypted, Zip64, or uncommon compression formats.',
		`Wildcards expand against a snapshot index of the vault (notes and attachments, plus ${AGENTS_MOUNT_POINT}); other hidden dot-folders are not in that index, so globs can report no matches for files that do exist. When a glob or rg finds nothing, list the parent directory or read the explicit path directly before concluding a file is missing.`,
		`Treat the filesystem root as the user's personal knowledge base — only write there for content the user intends to keep; use ${BASH_TMP_MOUNT_POINT} for intermediate or scratch work.`,
		`The plugin settings file ${SETTINGS_MOUNT_POINT}/settings.json is virtual and reflects live settings (whitelist only, never credentials). To change settings, write the complete file as valid JSON — prefer jq or a full-file rewrite; the plugin validates and applies it on save.`,
		`The required "purpose" field is a very short (up to 120 characters) plain-language summary of what this command does and why it is being run, written in the same language as the user's request and safe for users who cannot read shell — no code, no markdown, no newlines, no shell syntax.`,
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
	execute: async (params, { context, toolCallId }) => {
		const {
			app,
			fileSystemManager,
			permissionGuard,
			readTracker,
			recordMetadata,
			getSettingsSnapshot,
			updateSettings,
		} = context
		const cwd = params.cwd || VAULT_MOUNT_POINT
		if (!isAllowedBashCwd(cwd)) {
			throw new Error(
				`Invalid bash cwd: ${cwd}. The cwd must be an absolute virtual path.`,
			)
		}

		const result = await execVaultBash(app, params.script, {
			cwd,
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
