import { moment } from 'obsidian'
import { isNotNil } from 'ramda'
import { IN_DEV } from '~/consts'
import { useLogsStorage } from '~/storage/logs'
import logger from '~/utils/logger'
import logsStringify from '~/utils/logs-stringify'
import NutstorePlugin from '..'

export default class LoggerService {
	logs: any[] = []
	logsFileName = moment().format('YYYY-MM-DD_HH-mm-ss') + '.log'
	logsStorage = useLogsStorage(this.plugin)

	constructor(private plugin: NutstorePlugin) {
		if (IN_DEV) {
			logger.addReporter({
				log: (logObj) => {
					const log = [
						moment(logObj.date).format('YYYY-MM-DD HH:mm:ss'),
						logObj.type,
						logObj.args,
					]
					this.logs.push(log)
				},
			})
		} else {
			logger.setReporters([
				{
					log: (logObj) => {
						this.logs.push(logObj)
					},
				},
			])
		}
	}

	async saveLogs() {
		try {
			const logs = this.logs.map(logsStringify).filter(isNotNil)
			this.logs = logs
			await this.logsStorage.set(this.logsFileName, logs.join('\n\n'))
		} catch (e) {
			logger.error('Error saving logs:', e)
		}
	}
}
