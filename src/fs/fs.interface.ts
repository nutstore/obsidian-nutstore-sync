import { StatModel } from '~/model/stat.model'

export type MaybePromise<T> = Promise<T> | T

export default abstract class IFileSystem {
	abstract walk(): MaybePromise<StatModel[]>
}
