import { BaseTask, toTaskError } from './task.interface'

/**
 * 如果文件名里存在坚果云不支持的特殊字符, 将无法上传.
 *
 * 此时可以创建该任务, 不做任何操作. 只在任务列表里告诉用户文件名有问题.
 */
export default class FilenameErrorTask extends BaseTask {
	exec() {
		return {
			success: false,
			error: toTaskError(
				new Error(
					'Filename contains unsupported characters: ' + this.localPath,
				),
				this,
			),
		} as const
	}
}
