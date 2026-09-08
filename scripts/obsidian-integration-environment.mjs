import { access, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// macOS has a 104-byte Unix-domain socket limit. The absolute repository path
// is too long for MicroSandbox's runtime socket, so use a short, project-only
// local cache path instead of a directory inside the working tree.
const MICRO_SANDBOX_ROOT = '/tmp/nutstore-obsidian-e2e'
const OBSIDIAN_VERSION = '1.13.7'
const OBSIDIAN_URL =
	'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.13.7/Obsidian-1.13.7-arm64.AppImage'
const UBUNTU_IMAGE =
	'ubuntu@sha256:95fa486768020359141f1318720f43e7982ef926c792891d984aef9aaf05e7ea'
const ROOT_DISK_MIB = 4096

const packages = [
	'ca-certificates',
	'curl',
	'xvfb',
	'libasound2t64',
	'libatk-bridge2.0-0',
	'libdrm2',
	'libgbm1',
	'libgtk-3-0',
	'libnss3',
	'libx11-xcb1',
	'libxcomposite1',
	'libxdamage1',
	'libxfixes3',
	'libxkbcommon0',
	'libxrandr2',
	'libxss1',
	'libxtst6',
	'libz1',
	'python3',
	'zlib1g-dev',
]

const environmentKey = createHash('sha256')
	.update(
		JSON.stringify({
			schema: 1,
			obsidianVersion: OBSIDIAN_VERSION,
			obsidianUrl: OBSIDIAN_URL,
			ubuntuImage: UBUNTU_IMAGE,
			packages,
		}),
	)
	.digest('hex')
	.slice(0, 16)
const SNAPSHOT_NAME = `obsidian-${OBSIDIAN_VERSION}-${environmentKey}`
const SNAPSHOT_PATH = join(MICRO_SANDBOX_ROOT, 'snapshots', SNAPSHOT_NAME)

async function microSandboxSdk() {
	// The runtime database is process-global. Keep it in the project cache so
	// an unrelated msb installation cannot leak migrations or sandboxes here.
	process.env.MSB_HOME = MICRO_SANDBOX_ROOT
	return import('microsandbox')
}

function bootstrapScript() {
	return [
		'set -eux',
		'export DEBIAN_FRONTEND=noninteractive',
		'apt-get update',
		`apt-get install -y --no-install-recommends ${packages.join(' ')}`,
		'mkdir -p /opt/obsidian',
		`curl --fail --location --retry 3 --output /opt/obsidian/Obsidian.AppImage ${OBSIDIAN_URL}`,
		'chmod +x /opt/obsidian/Obsidian.AppImage',
		'cd /opt/obsidian',
		'./Obsidian.AppImage --appimage-extract',
		'mv squashfs-root app',
		'rm Obsidian.AppImage',
		'Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &',
		'set +e',
		'timeout 10s env DISPLAY=:99 /opt/obsidian/app/obsidian --no-sandbox --user-data-dir=/tmp/obsidian-bootstrap-profile --vault=/tmp/obsidian-bootstrap-vault',
		'status=$?',
		'set -e',
		'test "$status" -eq 124',
	].join('\n')
}

async function exists(path) {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

export async function ensureObsidianSnapshot(log = console.log) {
	await mkdir(MICRO_SANDBOX_ROOT, { recursive: true })
	const { Sandbox, setup } = await microSandboxSdk()
	await setup().baseDir(MICRO_SANDBOX_ROOT).install()
	if (await exists(join(SNAPSHOT_PATH, 'snapshot.json'))) return SNAPSHOT_PATH

	const bootstrapName = `obsidian-bootstrap-${environmentKey}-${Date.now()}`
	log('[obsidian-e2e] creating local MicroSandbox environment (first run only)')
	const sandbox = await Sandbox.builder(bootstrapName)
		.image(UBUNTU_IMAGE)
		.rootDisk(ROOT_DISK_MIB)
		.memory(2048)
		.cpus(2)
		.create()
	try {
		const output = await sandbox.shell(bootstrapScript())
		if (!output.success) {
			throw new Error(
				`Could not prepare local Obsidian environment:\n${output.stderr()}`,
			)
		}
		await sandbox.stop()
		await sandbox.waitForStatus('stopped')
		await (await Sandbox.get(bootstrapName)).snapshot(SNAPSHOT_NAME)
		log('[obsidian-e2e] local Obsidian environment is ready')
	} finally {
		try {
			await (await Sandbox.get(bootstrapName)).destroy()
		} catch {
			// The bootstrap sandbox is only a build worker. A successful snapshot
			// remains available even when cleanup has already removed the worker.
		}
	}
	return SNAPSHOT_PATH
}

export async function createObsidianSandbox() {
	const snapshot = await ensureObsidianSnapshot()
	const { Sandbox } = await microSandboxSdk()
	return Sandbox.builder(`obsidian-test-${Date.now()}`)
		.fromSnapshot(snapshot)
		.memory(2048)
		.cpus(2)
		.ephemeral(true)
		.network((network) => network.enabled(false))
		.create()
}

export async function startObsidian(sandbox) {
	return sandbox.shellStream(
		[
			'set -eu',
			'Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &',
			'exec env DISPLAY=:99 /opt/obsidian/app/obsidian --no-sandbox --disable-gpu --disable-dev-shm-usage --enable-logging=stderr --remote-debugging-port=9222 --user-data-dir=/root/obsidian-profile --vault=/root/nutstore-vault',
		].join('\n'),
	)
}
