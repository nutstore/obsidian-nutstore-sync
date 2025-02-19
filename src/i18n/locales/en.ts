export default {
	settings: {
		title: 'WebDAV Settings',
		account: {
			name: 'Account',
			desc: 'Enter your WebDAV account',
			placeholder: 'Enter your account',
		},
		credential: {
			name: 'Credential',
			desc: 'Enter your WebDAV credential',
			placeholder: 'Enter your credential',
		},
		checkConnection: {
			name: 'Check Connection',
			desc: 'Click to check WebDAV connection',
			success: 'WebDAV connection successful',
			failure: 'WebDAV connection failed',
		},
		remoteDir: {
			name: 'Remote Directory',
			desc: 'Enter the remote directory',
			placeholder: 'Enter the remote directory',
		},
		login: {
			name: 'Login',
			desc: 'Click to login',
		},
	},
	sync: {
		failed: 'Sync failed!',
		error: {
			folderButFile: 'Expected folder but found file: {{path}}',
		},
		start: 'Sync started.',
		complete: 'Sync completed.',
		completeWithFailed: 'Sync completed with {{failedCount}} failed tasks.',
		failedWithError: 'Sync failed with error: {{error}}',
		progress: 'Sync progress: {{completed}}/{{total}}',
		startButton: 'Start Sync',
		failedStatus: 'Sync Failed',
	},
}
