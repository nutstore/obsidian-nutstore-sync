import type { ConsolaReporter, LogObject } from 'consola'
import logger from '~/utils/logger'
import logsStringify from '~/utils/logs-stringify'
import { formatLocalTimestamp } from '~/utils/local-date'
import {
	LogRetention,
	type LogRetentionStats,
	type LogSink,
} from './log-retention'
import { BaseService } from './service.interface'
import NutstorePlugin from '..'

export interface LogEntry {
	timestamp: string
	level: string
	args: unknown[]
}

/**
 * The plugin's only long-lived log storage, feeding "save logs to note".
 *
 * Every line is formatted at write time, not at save time: the saved text must
 * describe the state the caller logged instead of a later mutation, and
 * retention must not keep live object graphs (tasks, responses, the plugin
 * itself) reachable. LogRetention then compresses the text into chunks and
 * bounds memory by bytes, so a six-figure line history costs a few MiB. Saving
 * streams one expanded chunk at a time, so it never re-materialises the whole
 * history in memory.
 */
export default class LoggerService extends BaseService {
	private readonly retention = new LogRetention()
	private attached = false
	private readonly reporter: ConsolaReporter = {
		log: (logObj: LogObject) => this.retain(logObj),
	}

	constructor(plugin: NutstorePlugin) {
		super()
		void plugin
	}

	override onload() {
		this.attach()
	}

	override onunload() {
		this.detach()
	}

	/** Streams retained log text, oldest first, for "save logs to note". */
	async writeLogsTo(sink: LogSink): Promise<void> {
		await this.retention.writeTo(sink)
	}

	/** What retention currently holds, and what it costs after compression. */
	get stats(): LogRetentionStats {
		return this.retention.stats
	}

	clear() {
		this.retention.clear()
	}

	/**
	 * Registration must stay symmetric: exactly one add in `onload`, one remove in
	 * `onunload`. Without the guard a second load would duplicate every line, and
	 * a missed removal would keep a dead service's retained text alive.
	 */
	private attach() {
		if (this.attached) return
		this.attached = true
		logger.addReporter(this.reporter)
	}

	private detach() {
		if (!this.attached) return
		this.attached = false
		logger.removeReporter(this.reporter)
	}

	private retain(logObj: LogObject) {
		// The sink is best-effort: losing one diagnostic must not fail the
		// operation that was being logged.
		try {
			this.retention.append(
				logsStringify({
					timestamp: formatLocalTimestamp(logObj.date),
					level: logObj.type,
					args: logObj.args,
				}) ?? '',
			)
		} catch {
			// See above: retention failure must not break the caller.
		}
	}
}
