import { createConsola, LogLevels } from 'consola'
import { IN_DEV } from '~/consts'

/**
 * The plugin's single logger.
 *
 * Two deliberate performance/memory decisions:
 * - `throttle: 0` disables consola's duplicate detection. That path serializes
 *   every payload with `JSON.stringify` before a reporter sees it, so on the
 *   sync hot path (one log per file and per task) it costs more than it saves.
 *   Bounding what is retained is the log sink's job instead (LoggerService).
 * - A shipped plugin never writes to the console: its only log consumer is the
 *   in-app buffer that LoggerService attaches in `onload`. Development keeps
 *   consola's default console reporter so logs stay visible while iterating.
 */
const options = {
	level: LogLevels.verbose,
	throttle: 0,
	formatOptions: {
		date: true,
		colors: false,
	},
}

const logger = IN_DEV
	? createConsola(options)
	: createConsola({ ...options, reporters: [] })

export default logger
