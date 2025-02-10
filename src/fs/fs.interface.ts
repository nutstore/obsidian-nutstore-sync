import { StatModel } from '~/model/stat.model'

export default abstract class IFileSystem {
	abstract walk(): Promise<StatModel[]>
}
