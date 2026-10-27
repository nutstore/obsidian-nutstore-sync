import {
	defineCommand,
	type CustomCommand,
	type ExecResult,
} from 'just-bash/browser'
import type { AppOpenFn } from '~/ai/apps/workspaces'

const USAGE = 'usage: app open [appId]'

function commandError(message: string): ExecResult {
	return { stdout: '', stderr: `app: ${message}\n`, exitCode: 1 }
}

function commandResult(value: unknown): ExecResult {
	return {
		stdout: `${JSON.stringify(value)}\n`,
		stderr: '',
		exitCode: 0,
	}
}

export interface AppCommandOptions {
	openApp?: AppOpenFn
	/** Currently selected App of the chat, or undefined when none is selected. */
	selectedAppId?: () => string | undefined
}

/**
 * `app open` renders an App and takes effect immediately. App source files are
 * ordinary vault files edited with the normal file tools, so this is the only
 * App-specific command.
 */
export function createAppCommands(options: AppCommandOptions): CustomCommand[] {
	return [
		defineCommand('app', async (args) => {
			const [operation, ...parameters] = args
			if (
				!operation ||
				operation === '-h' ||
				operation === '--help' ||
				operation === 'help'
			)
				return { stdout: `${USAGE}\n`, stderr: '', exitCode: 0 }
			if (operation !== 'open' || parameters.length > 1)
				return commandError(USAGE)
			const open = options.openApp
			if (!open)
				return commandError('App opening is unavailable in this execution')
			const appId = parameters[0]?.trim() || options.selectedAppId?.()
			if (!appId)
				return commandError(
					'No App is selected in this chat. Pass an App ID to open one.',
				)
			try {
				const opened = await open(appId)
				return commandResult({
					appId: opened.appId,
					title: opened.title,
					opened: true,
				})
			} catch (error) {
				return commandError(
					error instanceof Error ? error.message : String(error),
				)
			}
		}),
	]
}
