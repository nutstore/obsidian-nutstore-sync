export default {
	settings: {
		title: 'WebDAV 设置',
		account: {
			name: '账号',
			desc: '输入你的 WebDAV 账号',
			placeholder: '输入你的账号',
		},
		credential: {
			name: '凭证',
			desc: '输入你的 WebDAV 凭证',
			placeholder: '输入你的凭证',
		},
		remoteDir: {
			name: '远程目录',
			desc: '输入远程目录',
			placeholder: '输入远程目录',
		},
		checkConnection: {
			name: '检查连接',
			desc: '点击检查 WebDAV 连接',
			success: 'WebDAV 连接成功',
			failure: 'WebDAV 连接失败',
		},
		login: {
			name: '登录',
			desc: '点击登录',
		},
	},
	sync: {
		failed: '同步失败!',
		error: {
			folderButFile: '预期文件夹但发现文件: {{path}}',
		},
		start: '同步开始。',
		complete: '同步完成。',
		completeWithFailed: '同步完成，但有 {{failedCount}} 个任务失败。',
		failedWithError: '同步失败，错误信息: {{error}}',
		progress: '同步进度: {{percent}}%',
		startButton: '开始同步',
		failedStatus: '同步失败',
		cancelled: '同步已取消。',
	},
}
