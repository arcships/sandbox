import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  throw new Error(`native runner is missing: ${runnerPath}; run pnpm native:build first`)
}

const root = join(tmpdir(), `dim-sandbox-platform-smoke-${process.pid}-${Date.now()}`)
const workspace = join(root, 'workspace')
const outside = join(root, 'outside')
const inside = join(workspace, 'inside.txt')
const outsideSecret = join(outside, 'secret.txt')
const outsideWrite = join(outside, 'denied.txt')
const readOnlyWrite = join(workspace, 'read-only-denied.txt')

mkdirSync(workspace, { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(inside, 'inside-file')
writeFileSync(outsideSecret, 'outside-secret')

const shellCommand = (script) => process.platform === 'win32'
  ? [process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', script]
  : ['/bin/sh', '-lc', script]

const quote = (value) => process.platform === 'win32'
  ? `"${value.replaceAll('"', '""')}"`
  : `'${value.replaceAll("'", "'\\''")}'`

const readCommand = (path) => process.platform === 'win32'
  ? shellCommand(`type ${quote(path)}`)
  : ['/bin/cat', path]

const writeCommand = (path, value) => process.platform === 'win32'
  ? shellCommand(`> ${quote(path)} echo ${value}`)
  : shellCommand(`printf ${quote(value)} > ${quote(path)}`)

const curlCommand = (url) => [
  process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl',
  '-fsS',
  '--connect-timeout',
  '5',
  '--max-time',
  '10',
  url,
]

const basePolicy = {
  enabled: true,
  mode: 'workspace-write',
  workspaceRoot: workspace,
  readableRoots: [workspace],
  writableRoots: [workspace],
  readDenyPaths: [outsideSecret],
  allowedDomains: [],
}

const requestEnv = Object.fromEntries(
  ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'ComSpec', 'TMP', 'TEMP', 'TMPDIR']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
)

const run = (requestId, command, policy = basePolicy) => {
  const child = spawnSync(runnerPath, ['run'], {
    input: JSON.stringify({
      version: 1,
      requestId,
      command,
      cwd: workspace,
      env: requestEnv,
      policy,
    }),
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    throw new Error(`native runner failed for ${requestId}: ${child.stderr}`)
  }
  return JSON.parse(child.stdout)
}

const detailsFor = (result) => ({
  exitCode: result.exitCode,
  signal: result.signal,
  stdout: result.stdout,
  stderr: result.stderr,
  diagnostics: result.diagnostics,
})

try {
  const insideRead = run('inside-read', readCommand(inside))
  const insideWrite = run('inside-write', writeCommand(join(workspace, 'allowed.txt'), 'allowed'))
  const outsideRead = run('outside-read', readCommand(outsideSecret))
  const outsideWriteResult = run('outside-write', writeCommand(outsideWrite, 'denied'))
  const blockedNetwork = run('network-blocked', curlCommand('https://example.com'))

  const allowlistedNetwork = run(
    'network-allowlisted',
    curlCommand('https://example.com'),
    { ...basePolicy, allowedDomains: ['example.com'] },
  )
  const nonAllowlistedNetwork = run(
    'network-non-allowlisted',
    curlCommand('https://www.iana.org'),
    { ...basePolicy, allowedDomains: ['example.com'] },
  )
  const fullNetwork = run(
    'network-full',
    curlCommand('https://example.com'),
    { ...basePolicy, allowedDomains: ['*'] },
  )

  const readOnlyPolicy = {
    ...basePolicy,
    mode: 'read-only',
    writableRoots: [],
    allowedDomains: ['*'],
  }
  const readOnlyRead = run('read-only-read', readCommand(inside), readOnlyPolicy)
  const readOnlyWriteResult = run('read-only-write', writeCommand(readOnlyWrite, 'denied'), readOnlyPolicy)

  const fileOffPolicy = {
    ...basePolicy,
    mode: 'off',
    readableRoots: [],
    writableRoots: [],
    readDenyPaths: [],
    allowedDomains: [],
  }
  const fileOffOutsideRead = run('file-off-outside-read', readCommand(outsideSecret), fileOffPolicy)
  const fileOffBlockedNetwork = run('file-off-network-blocked', curlCommand('https://example.com'), fileOffPolicy)

  const summary = {
    platform: process.platform,
    arch: process.arch,
    backend: insideRead.backend,
    insideRead: detailsFor(insideRead),
    insideWrite: detailsFor(insideWrite),
    outsideRead: detailsFor(outsideRead),
    outsideWrite: detailsFor(outsideWriteResult),
    outsideWriteCreated: existsSync(outsideWrite),
    blockedNetwork: detailsFor(blockedNetwork),
    allowlistedNetwork: detailsFor(allowlistedNetwork),
    nonAllowlistedNetwork: detailsFor(nonAllowlistedNetwork),
    fullNetwork: detailsFor(fullNetwork),
    readOnlyRead: detailsFor(readOnlyRead),
    readOnlyWrite: detailsFor(readOnlyWriteResult),
    readOnlyWriteCreated: existsSync(readOnlyWrite),
    fileOffOutsideRead: detailsFor(fileOffOutsideRead),
    fileOffBlockedNetwork: detailsFor(fileOffBlockedNetwork),
  }
  console.log(JSON.stringify(summary, null, 2))

  if (
    summary.insideRead.exitCode !== 0
    || summary.insideWrite.exitCode !== 0
    || summary.outsideRead.exitCode === 0
    || summary.outsideWrite.exitCode === 0
    || summary.outsideWriteCreated
    || summary.blockedNetwork.exitCode === 0
    || summary.allowlistedNetwork.exitCode !== 0
    || summary.nonAllowlistedNetwork.exitCode === 0
    || summary.fullNetwork.exitCode !== 0
    || summary.readOnlyRead.exitCode !== 0
    || summary.readOnlyWrite.exitCode === 0
    || summary.readOnlyWriteCreated
    || summary.fileOffOutsideRead.exitCode !== 0
    || summary.fileOffBlockedNetwork.exitCode === 0
  ) {
    throw new Error('native sandbox platform smoke test failed')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
