import { moment } from 'obsidian'
import { IN_DEV } from '~/consts'
import logger from '~/utils/logger'
import { BaseService } from './service.interface'
import NutstorePlugin from '..'

export interface LogEntry {
	timestamp: string
	level: string
	args: any[]
}

export default class LoggerService extends BaseService {
	logs: LogEntry[] = []

	constructor(plugin: NutstorePlugin) {
		super()
		void plugin
	}

	override onload() {
		const reporter = {
			log: (logObj: any) => {
				this.logs.push({
					timestamp: moment(logObj.date).format('YYYY-MM-DD HH:mm:ss'),
					level: logObj.type,
					args: logObj.args,
				})
			},
		}
		if (IN_DEV) {
			// Keep default Consola console reporter; add ours alongside it.
			logger.addReporter(reporter)
		} else {
			logger.setReporters([reporter])
		}
	}

	clear() {
		this.logs = []
	}
}
