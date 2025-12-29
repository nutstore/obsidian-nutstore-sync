import { StatModel } from '~/model/stat.model'
import { MaybePromise } from '~/utils/types'

export interface FsWalkResult {
	stat: StatModel
	ignored: boolean
}

export default abstract class AbstractFileSystem {
	abstract walk(): MaybePromise<FsWalkResult[]>
}
