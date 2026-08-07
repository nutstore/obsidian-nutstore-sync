import { posix as pathPosix } from 'path-browserify'
import { idAgent } from 'id-agent'
import { tool } from 'ai'
import { z } from 'zod/mini'
import {
	AGENTS_MOUNT_POINT,
	BUILTIN_SKILLS_MOUNT_POINT,
	execVaultBash,
	VAULT_MOUNT_POINT,
} from '~/ai/tools/bash/runtime'
import { BASH_TMP_MOUNT_POINT, writeBashTmpText } from '~/ai/tools/bash/tmp-fs'
import {
	appDep,
	permissionGuardDep,
	readTrackerDep,
	recordMetadataDep,
	scratchDep,
} from '~/ai/tools/tool-context'
import { booleanValue, textValue } from '../shared'

const MAX_INLINE_BASH_OUTPUT_CHARS = 20 * 1024

function isAllowedBashCwd(pathValue: string) {
	const normalized = pathPosix.normalize(
		pathPosix.resolve('/', pathValue || '/'),
	)
	return (
		normalized === '/' ||
		normalized === BASH_TMP_MOUNT_POINT ||
		normalized.startsWith(`${BASH_TMP_MOUNT_POINT}/`) ||
		normalized === AGENTS_MOUNT_POINT ||
		normalized.startsWith(`${AGENTS_MOUNT_POINT}/`) ||
		normalized === VAULT_MOUNT_POINT ||
		normalized.startsWith(`${VAULT_MOUNT_POINT}/`)
	)
}

export const bashTool = tool({
	description: [
		`Execute a browser-based bash subset against a virtual filesystem where the Obsidian vault is mounted at ${VAULT_MOUNT_POINT}, agent data is mounted at ${AGENTS_MOUNT_POINT}, and built-in Skills are read-only under ${BUILTIN_SKILLS_MOUNT_POINT}.`,
		'This is not the host shell: node, python, xxd, and some command flags are unavailable.',
		'Prefer supported commands such as ls, cat, rg, sed, awk, od, mkdir, mv, cp, and rm.',
		`Treat ${VAULT_MOUNT_POINT} as the user's personal knowledge base — only write there for content the user intends to keep; use ${BASH_TMP_MOUNT_POINT} for intermediate or scratch work.`,
	].join(' '),
	inputSchema: z.object({
		script: textValue('script'),
		cwd: z._default(z.string(), VAULT_MOUNT_POINT),
		stdin: z.optional(z.string()),
		rawScript: z._default(booleanValue('rawScript'), false),
	}),
	contextSchema: z.object({
		app: appDep,
		permissionGuard: permissionGuardDep,
		scratch: scratchDep,
		readTracker: readTrackerDep,
		recordMetadata: recordMetadataDep,
	}),
	outputSchema: z.string(),
	execute: async (params, { context, toolCallId }) => {
		const { app, permissionGuard, scratch, readTracker, recordMetadata } =
			context
		const cwd = params.cwd || VAULT_MOUNT_POINT
		if (!isAllowedBashCwd(cwd)) {
			throw new Error(
				`Invalid bash cwd: ${cwd}. Allowed roots are /, ${VAULT_MOUNT_POINT}, ${AGENTS_MOUNT_POINT}, and ${BASH_TMP_MOUNT_POINT}`,
			)
		}

		const result = await execVaultBash(app, params.script, {
			cwd,
			stdin: params.stdin,
			rawScript: params.rawScript,
			permissionGuard,
			onRead: readTracker?.markRead.bind(readTracker),
			scratch,
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
