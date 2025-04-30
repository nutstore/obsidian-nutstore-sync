import { StatModel } from '~/model/stat.model'
import { MaybePromise } from '~/utils/types'

export default abstract class IFileSystem {
	abstract walk(): MaybePromise<StatModel[]>
}
