import { getInvalidChars } from '../../utils/has-invalid-char'
import { BaseTask, toTaskError } from './task.interface'

import i18n from '~/i18n'

export class FilenameError extends Error {
	constructor(
		public readonly invalidChars: string[],
		public readonly filePath: string,
	) {
		super()
		this.name = 'FilenameError'
		Object.setPrototypeOf?.(this, new.target.prototype)
		Object.defineProperty(this, 'message', {
			configurable: true,
			get: () => FilenameError.format(this.invalidChars, this.filePath),
		})
	}

	private static format(invalidChars: string[], filePath: string) {
		const unique = Array.from(new Set(invalidChars))
		const charList = unique.map((c) => `'${c}'`).join(', ')
		return i18n.t('errors.filenameUnsupportedChars', {
			chars: charList,
			path: filePath,
		})
	}
}

/**
 * 如果文件名里存在坚果云不支持的特殊字符, 将无法上传.
 *
 * 此时可以创建该任务, 不做任何操作. 只在任务列表里告诉用户文件名有问题.
 */
export default class FilenameErrorTask extends BaseTask {
	exec() {
		const invalidChars = getInvalidChars(this.localPath)
		return {
			success: false,
			error: toTaskError(new FilenameError(invalidChars, this.localPath), this),
		} as const
	}
}
