import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const runnerArg = args.find((arg) => !arg.startsWith('--'))
const runnerPath = resolve(
  runnerArg
    ?? join(repoRoot, 'native', 'target', 'release', process.platform === 'win32'
      ? 'dim-sandbox-runner.exe'
      : 'dim-sandbox-runner'),
)

if (!existsSync(runnerPath)) {
  throw new Error(`native runner is missing: ${runnerPath}`)
}

const root = join(tmpdir(), `dim-sandbox-protocol-${process.pid}-${Date.now()}`)
mkdirSync(root, { recursive: true })

const command = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', 'echo protocol-ok']
  : ['/bin/sh', '-lc', 'printf protocol-ok']

const request = {
  version: 1,
  requestId: 'protocol-v1',
  command,
  cwd: root,
  env: {},
  policy: {
    enabled: false,
    mode: 'off',
    workspaceRoot: root,
    readableRoots: [],
    writableRoots: [],
    readDenyPaths: [],
    allowedDomains: ['*'],
  },
}

const invoke = (input) => spawnSync(runnerPath, ['run'], {
  input: JSON.stringify(input),
  encoding: 'utf8',
})

try {
  const supported = invoke(request)
  if (supported.status !== 0) {
    throw new Error(`protocol v1 request failed: ${supported.stderr}`)
  }
  const result = JSON.parse(supported.stdout)
  if (
    result.version !== 1
    || result.requestId !== request.requestId
    || result.exitCode !== 0
    || !String(result.stdout).includes('protocol-ok')
  ) {
    throw new Error(`protocol v1 response mismatch: ${supported.stdout}`)
  }

  const unsupported = invoke({ ...request, version: 255, requestId: 'protocol-unsupported' })
  if (
    unsupported.status === 0
    || !String(unsupported.stderr).includes('unsupported dim-sandbox runner protocol version')
  ) {
    throw new Error('unsupported protocol version did not fail fast')
  }

  console.log(JSON.stringify({
    runnerPath,
    supportedVersion: 1,
    backend: result.backend,
    unsupportedVersionRejected: true,
  }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
