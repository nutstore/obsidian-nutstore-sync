import { StatModel } from './stat.model'

export interface SyncRecordModel {
	local: StatModel
	remote: StatModel
	base?: {
		key: string
	}
}
