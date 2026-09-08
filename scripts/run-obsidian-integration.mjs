import {
	access,
	cp,
	mkdtemp,
	mkdir,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { rawTextPlugin } from './esbuild/plugins/raw-text.mjs'
import {
	createObsidianSandbox,
	startObsidian,
} from './obsidian-integration-environment.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGIN_ID = 'nutstore-sync'
const HARNESS_ID = 'nutstore-sync-integration-harness'
const RESULT_PATH = '.obsidian/nutstore-sync-e2e-result.json'
const STARTUP_TIMEOUT_MS = Number.parseInt(
	process.env.OBSIDIAN_E2E_STARTUP_TIMEOUT_MS ?? '60000',
	10,
)

const ENABLE_COMMUNITY_PLUGINS_SCRIPT = String.raw`
import base64
import hashlib
import http.client
import json
import os
import socket
import struct
import sys
import time
from urllib.parse import urlparse

def read_exact(connection, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = connection.recv(remaining)
        if not chunk:
            raise RuntimeError('DevTools socket closed before a complete frame arrived')
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)

def send_frame(connection, payload):
    payload = payload.encode('utf-8')
    mask = os.urandom(4)
    if len(payload) < 126:
        header = bytes([0x81, 0x80 | len(payload)])
    elif len(payload) < 65536:
        header = bytes([0x81, 0x80 | 126]) + struct.pack('!H', len(payload))
    else:
        header = bytes([0x81, 0x80 | 127]) + struct.pack('!Q', len(payload))
    masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    connection.sendall(header + mask + masked)

def receive_frame(connection):
    first, second = read_exact(connection, 2)
    opcode = first & 0x0f
    size = second & 0x7f
    if size == 126:
        size = struct.unpack('!H', read_exact(connection, 2))[0]
    elif size == 127:
        size = struct.unpack('!Q', read_exact(connection, 8))[0]
    masked = second & 0x80
    mask = read_exact(connection, 4) if masked else None
    payload = read_exact(connection, size)
    if masked:
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return opcode, payload

def evaluate(url, expression):
    parsed = urlparse(url)
    connection = socket.create_connection((parsed.hostname, parsed.port), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode('ascii')
    connection.sendall((
        'GET ' + parsed.path + ' HTTP/1.1\r\n'
        'Host: ' + parsed.hostname + ':' + str(parsed.port) + '\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        'Sec-WebSocket-Key: ' + key + '\r\n'
        'Sec-WebSocket-Version: 13\r\n\r\n'
    ).encode('ascii'))
    response = b''
    while b'\r\n\r\n' not in response:
        response += connection.recv(4096)
    if not response.startswith(b'HTTP/1.1 101'):
        raise RuntimeError('DevTools WebSocket upgrade failed: ' + response.decode('utf-8', 'replace'))
    send_frame(connection, json.dumps({
        'id': 1,
        'method': 'Runtime.evaluate',
        'params': {'expression': expression, 'returnByValue': True},
    }))
    while True:
        opcode, payload = receive_frame(connection)
        if opcode == 1:
            message = json.loads(payload)
            if message.get('id') == 1:
                return message

deadline = time.monotonic() + 30
last_error = None
while time.monotonic() < deadline:
    try:
        client = http.client.HTTPConnection('127.0.0.1', 9222, timeout=2)
        client.request('GET', '/json/list')
        targets = json.loads(client.getresponse().read())
        target = next(item for item in targets if item.get('type') == 'page')
        response = evaluate(
            target['webSocketDebuggerUrl'],
            "localStorage.setItem('enable-plugin-' + app.appId, 'true'); app.appId",
        )
        if 'exceptionDetails' not in response.get('result', {}):
            print(response['result']['result'].get('value', ''))
            sys.exit(0)
        last_error = response['result']['exceptionDetails'].get('text', 'runtime evaluation failed')
    except Exception as error:
        last_error = str(error)
    time.sleep(0.25)
raise RuntimeError('Could not enable community plugins in the guest: ' + str(last_error))
`

function fail(message) {
	throw new Error(`[obsidian-e2e] ${message}`)
}

async function exists(path) {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

async function buildHarness(outfile) {
	await esbuild.build({
		entryPoints: [join(ROOT, 'test/obsidian/harness.ts')],
		outfile,
		bundle: true,
		format: 'cjs',
		platform: 'browser',
		target: 'es2018',
		external: ['obsidian'],
		alias: {
			'~': join(ROOT, 'src'),
			'node:zlib': join(ROOT, 'src/shims/node-zlib.ts'),
		},
		plugins: [rawTextPlugin],
	})
}

async function installPlugin(source, target) {
	await mkdir(target, { recursive: true })
	await cp(source, join(target, 'main.js'))
	await cp(join(ROOT, 'manifest.json'), join(target, 'manifest.json'))
	if (await exists(join(ROOT, 'styles.css'))) {
		await cp(join(ROOT, 'styles.css'), join(target, 'styles.css'))
	}
}

async function prepareVault(root) {
	const vault = join(root, 'vault')
	const plugins = join(vault, '.obsidian', 'plugins')
	await mkdir(plugins, { recursive: true })
	await writeFile(
		join(vault, '.obsidian', 'app.json'),
		JSON.stringify({ restrictedMode: false }),
	)
	await writeFile(
		join(vault, '.obsidian', 'community-plugins.json'),
		JSON.stringify([PLUGIN_ID, HARNESS_ID]),
	)
	await installPlugin(join(ROOT, 'main.js'), join(plugins, PLUGIN_ID))
	const harnessDir = join(plugins, HARNESS_ID)
	await mkdir(harnessDir, { recursive: true })
	await buildHarness(join(harnessDir, 'main.js'))
	await writeFile(
		join(harnessDir, 'manifest.json'),
		JSON.stringify({
			id: HARNESS_ID,
			name: 'Nutstore Sync Integration Harness',
			version: '0.0.0',
			minAppVersion: '1.7.2',
			description: 'Private integration test harness.',
			isDesktopOnly: false,
		}),
	)
	return vault
}

async function copyDirectoryToGuest(sandbox, hostPath, guestPath) {
	const fs = sandbox.fs()
	await fs.mkdir(guestPath)
	for (const entry of await readdir(hostPath, { withFileTypes: true })) {
		const hostEntry = join(hostPath, entry.name)
		const guestEntry = `${guestPath}/${entry.name}`
		if (entry.isDirectory()) {
			await copyDirectoryToGuest(sandbox, hostEntry, guestEntry)
		} else if (entry.isFile()) {
			await fs.copyFromHost(hostEntry, guestEntry)
		}
	}
}

async function prepareGuestProfile(sandbox) {
	const fs = sandbox.fs()
	await fs.mkdir('/root/obsidian-profile')
	await fs.write(
		'/root/obsidian-profile/obsidian.json',
		JSON.stringify({
			vaults: {
				e2e0000000000001: {
					path: '/root/nutstore-vault',
					ts: Date.now(),
					open: true,
				},
			},
		}),
	)
	await fs.write('/root/obsidian-profile/e2e0000000000001.json', '{}')
}

async function enableCommunityPlugins(sandbox) {
	const fs = sandbox.fs()
	const scriptPath = '/tmp/enable-community-plugins.py'
	await fs.write(scriptPath, ENABLE_COMMUNITY_PLUGINS_SCRIPT)
	const output = await sandbox.exec('python3', [scriptPath])
	if (!output.success) {
		fail(`Could not enable community plugins in the guest:\n${output.stderr()}`)
	}
}

async function waitForResult(sandbox) {
	const fs = sandbox.fs()
	const path = `/root/nutstore-vault/${RESULT_PATH}`
	const deadline = Date.now() + STARTUP_TIMEOUT_MS
	while (Date.now() < deadline) {
		try {
			const parsed = JSON.parse(await fs.readToString(path))
			// The harness writes a `started: true` sentinel on load and only
			// clears it in the final result, so keep polling until it finishes.
			if (!parsed.started) return parsed
		} catch {
			// The result file may not exist yet on a fresh guest.
		}
		await delay(250)
	}
	fail('Timed out waiting for the integration harness result')
}

async function retainGuestArtifacts(sandbox, artifactRoot) {
	const fs = sandbox.fs()
	const diagnostics = join(artifactRoot, 'guest-diagnostics')
	await mkdir(diagnostics, { recursive: true })
	for (const [guestPath, name] of [
		['/root/nutstore-vault/.obsidian/appearance.json', 'appearance.json'],
		['/root/nutstore-vault/.obsidian/workspace.json', 'workspace.json'],
		[
			'/root/nutstore-vault/.obsidian/workspace-mobile.json',
			'workspace-mobile.json',
		],
		[
			'/root/nutstore-vault/.obsidian/nutstore-sync-e2e-result.json',
			'result.json',
		],
		['/root/obsidian-profile/obsidian.json', 'obsidian.json'],
		['/root/obsidian-profile/e2e0000000000001.json', 'vault-profile.json'],
	]) {
		try {
			await fs.copyToHost(guestPath, join(diagnostics, name))
		} catch {
			// A guest that failed before setup may not have created every file.
		}
	}
	await writeFile(
		join(diagnostics, 'exec-log.json'),
		JSON.stringify(await sandbox.logs(), null, 2),
	)
}

async function main() {
	for (const required of ['main.js', 'manifest.json']) {
		if (!(await exists(join(ROOT, required)))) {
			fail(`Missing ${required}; run pnpm build before test:obsidian`)
		}
	}
	const artifactRoot = await mkdtemp(join(tmpdir(), 'nutstore-obsidian-e2e-'))
	const vault = await prepareVault(artifactRoot)
	let sandbox
	let obsidian
	let passed = false
	try {
		sandbox = await createObsidianSandbox()
		await copyDirectoryToGuest(sandbox, vault, '/root/nutstore-vault')
		await prepareGuestProfile(sandbox)
		obsidian = await startObsidian(sandbox)
		await enableCommunityPlugins(sandbox)
		await delay(1_000)
		await obsidian.signal(15)
		await obsidian.wait()
		obsidian = await startObsidian(sandbox)
		const result = await waitForResult(sandbox)
		const failures = result.results.filter((entry) => entry.error)
		if (!result.passed || failures.length > 0) {
			fail(`Harness failures:\n${JSON.stringify(failures, null, 2)}`)
		}
		console.log(
			`[obsidian-e2e] ${result.results.length} real Obsidian checks passed`,
		)
		passed = true
	} finally {
		if (sandbox) {
			if (!passed) await retainGuestArtifacts(sandbox, artifactRoot)
			try {
				await sandbox.stop()
			} catch {
				// The disposable sandbox may already have stopped after a failed app launch.
			}
			try {
				await obsidian?.wait()
			} catch {
				// Stopping the disposable guest ends its foreground Obsidian command.
			}
			try {
				await sandbox.destroy()
			} catch {
				// Ephemeral sandboxes are removed automatically after they stop.
			}
		}
		if (passed) {
			await rm(artifactRoot, { recursive: true, force: true })
		} else {
			console.error(`[obsidian-e2e] artifacts retained at ${artifactRoot}`)
		}
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
