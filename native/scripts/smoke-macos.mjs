import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runnerPath = join(nativeDir, 'target', 'release', 'dim-sandbox-runner')

if (process.platform !== 'darwin') {
  throw new Error('sandbox:native:smoke:macos must run on macOS')
}
if (!existsSync(runnerPath)) {
  throw new Error(`native runner is missing: ${runnerPath}; run pnpm native:build first`)
}

const smokeRoot = join(tmpdir(), `.dim-sandbox-smoke-${process.pid}-${Date.now()}`)
const workspace = join(smokeRoot, 'workspace')
const outside = join(smokeRoot, 'outside')
const secret = join(outside, 'secret.txt')
const outsideWrite = join(outside, 'denied.txt')
const fileOffOutsideWritePath = join(outside, 'file-off.txt')
const readOnlyInside = join(workspace, 'inside.txt')
const readOnlyWrite = join(workspace, 'read-only-denied.txt')
const tmpWrite = join(tmpdir(), `dim-sandbox-smoke-${process.pid}-${Date.now()}.txt`)

mkdirSync(workspace, { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(secret, 'classified')
writeFileSync(readOnlyInside, 'inside-file')

const policy = {
  enabled: true,
  mode: 'workspace-write',
  workspaceRoot: workspace,
  readableRoots: [workspace],
  writableRoots: [workspace],
  readDenyPaths: [secret],
  allowedDomains: [],
}

const run = (requestId, command, policyOverride = policy) => {
  const child = spawnSync(runnerPath, ['run'], {
    input: JSON.stringify({
      version: 1,
      requestId,
      command,
      cwd: workspace,
      env: {},
      policy: policyOverride,
    }),
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    throw new Error(`native runner failed for ${requestId}: ${child.stderr}`)
  }
  return JSON.parse(child.stdout)
}

try {
  const workspaceWrite = run('workspace-write', ['/bin/sh', '-lc', 'printf allowed > allowed.txt'])
  const outsideWriteResult = run('outside-write', ['/bin/sh', '-lc', `printf denied > ${JSON.stringify(outsideWrite)}`])
  const secretRead = run('secret-read', ['/bin/cat', secret])
  const network = run('network-deny', ['/usr/bin/curl', '-fsS', '--connect-timeout', '2', 'https://example.com'])
  const tmpWriteResult = run('tmp-write', ['/bin/sh', '-lc', `printf temporary > ${JSON.stringify(tmpWrite)}`])
  const allowlistPolicy = {
    ...policy,
    allowedDomains: ['example.com'],
  }
  const allowlistedNetwork = run(
    'network-allowlist-example',
    ['/usr/bin/curl', '-fsS', '--connect-timeout', '5', '--max-time', '10', 'https://example.com'],
    allowlistPolicy,
  )
  const nonAllowlistedNetwork = run(
    'network-deny-non-allowlisted',
    ['/usr/bin/curl', '-fsS', '--connect-timeout', '5', '--max-time', '10', 'https://www.iana.org'],
    allowlistPolicy,
  )
  const fullNetwork = run(
    'network-full-access',
    ['/usr/bin/curl', '-fsS', '--connect-timeout', '5', '--max-time', '10', 'https://example.com'],
    { ...policy, allowedDomains: ['*'] },
  )
  const fileOffNetworkBlockedPolicy = {
    ...policy,
    mode: 'off',
    readableRoots: [],
    writableRoots: [],
    readDenyPaths: [],
    allowedDomains: [],
  }
  const fileOffOutsideRead = run('file-off-outside-read', ['/bin/cat', secret], fileOffNetworkBlockedPolicy)
  const fileOffOutsideWrite = run(
    'file-off-outside-write',
    ['/bin/sh', '-lc', `printf file-off > ${JSON.stringify(fileOffOutsideWritePath)} && cat ${JSON.stringify(fileOffOutsideWritePath)}`],
    fileOffNetworkBlockedPolicy,
  )
  const fileOffNetworkBlocked = run(
    'file-off-network-blocked',
    ['/usr/bin/curl', '-fsS', '--connect-timeout', '2', 'https://example.com'],
    fileOffNetworkBlockedPolicy,
  )
  const fileOffAllowlistPolicy = {
    ...fileOffNetworkBlockedPolicy,
    allowedDomains: ['example.com'],
  }
  const fileOffAllowlistedNetwork = run(
    'file-off-network-allowlist-example',
    ['/usr/bin/curl', '-fsS', '--connect-timeout', '5', '--max-time', '10', 'https://example.com'],
    fileOffAllowlistPolicy,
  )
  const fileOffNonAllowlistedNetwork = run(
    'file-off-network-deny-non-allowlisted',
    ['/usr/bin/curl', '-fsS', '--connect-timeout', '5', '--max-time', '10', 'https://www.iana.org'],
    fileOffAllowlistPolicy,
  )
  const fileOffFullNetwork = run(
    'file-off-network-full-access',
    ['/usr/bin/curl', '-fsS', '--connect-timeout', '5', '--max-time', '10', 'https://example.com'],
    { ...fileOffNetworkBlockedPolicy, allowedDomains: ['*'] },
  )
  const readOnlyPolicy = {
    ...policy,
    mode: 'read-only',
    writableRoots: [],
    allowedDomains: ['*'],
  }
  const readOnlyWorkspaceRead = run('read-only-workspace-read', ['/bin/cat', readOnlyInside], readOnlyPolicy)
  const readOnlyWorkspaceWrite = run(
    'read-only-workspace-write',
    ['/bin/sh', '-lc', `printf denied > ${JSON.stringify(readOnlyWrite)}`],
    readOnlyPolicy,
  )
  const readOnlyNetwork = run(
    'read-only-network-full-access',
    ['/usr/bin/curl', '-fsS', '--connect-timeout', '5', '--max-time', '10', 'https://example.com'],
    readOnlyPolicy,
  )

  const summary = {
    backend: workspaceWrite.backend,
    workspaceWrite: {
      exitCode: workspaceWrite.exitCode,
      fileCreated: existsSync(join(workspace, 'allowed.txt')),
    },
    outsideWrite: {
      exitCode: outsideWriteResult.exitCode,
      fileCreated: existsSync(outsideWrite),
      stderr: outsideWriteResult.stderr,
    },
    deniedSecretRead: {
      exitCode: secretRead.exitCode,
      stdout: secretRead.stdout,
      stderr: secretRead.stderr,
    },
    deniedNetwork: {
      exitCode: network.exitCode,
      stderr: network.stderr,
    },
    allowlistedNetwork: {
      exitCode: allowlistedNetwork.exitCode,
      stdoutPrefix: allowlistedNetwork.stdout.slice(0, 40),
      stderr: allowlistedNetwork.stderr,
    },
    nonAllowlistedNetwork: {
      exitCode: nonAllowlistedNetwork.exitCode,
      stderr: nonAllowlistedNetwork.stderr,
    },
    fullNetwork: {
      exitCode: fullNetwork.exitCode,
      stdoutPrefix: fullNetwork.stdout.slice(0, 40),
      stderr: fullNetwork.stderr,
    },
    fileOffNetworkSplit: {
      outsideReadExitCode: fileOffOutsideRead.exitCode,
      outsideReadStdout: fileOffOutsideRead.stdout,
      outsideWriteExitCode: fileOffOutsideWrite.exitCode,
      outsideWriteStdout: fileOffOutsideWrite.stdout,
      outsideWriteCreated: existsSync(fileOffOutsideWritePath),
      blockedNetworkExitCode: fileOffNetworkBlocked.exitCode,
      blockedNetworkStderr: fileOffNetworkBlocked.stderr,
      allowlistedNetworkExitCode: fileOffAllowlistedNetwork.exitCode,
      allowlistedNetworkStdoutPrefix: fileOffAllowlistedNetwork.stdout.slice(0, 40),
      nonAllowlistedNetworkExitCode: fileOffNonAllowlistedNetwork.exitCode,
      nonAllowlistedNetworkStderr: fileOffNonAllowlistedNetwork.stderr,
      fullNetworkExitCode: fileOffFullNetwork.exitCode,
      fullNetworkStdoutPrefix: fileOffFullNetwork.stdout.slice(0, 40),
    },
    readOnly: {
      workspaceReadExitCode: readOnlyWorkspaceRead.exitCode,
      workspaceReadStdout: readOnlyWorkspaceRead.stdout,
      workspaceWriteExitCode: readOnlyWorkspaceWrite.exitCode,
      workspaceWriteCreated: existsSync(readOnlyWrite),
      workspaceWriteStderr: readOnlyWorkspaceWrite.stderr,
      networkExitCode: readOnlyNetwork.exitCode,
      networkStdoutPrefix: readOnlyNetwork.stdout.slice(0, 40),
      networkStderr: readOnlyNetwork.stderr,
    },
    temporaryDirectoryWrite: {
      exitCode: tmpWriteResult.exitCode,
      fileCreated: existsSync(tmpWrite),
      note: 'dim workspace-write only permits configured writable roots by default',
    },
  }

  console.log(JSON.stringify(summary, null, 2))

  if (
    summary.backend !== 'codex-derived-macos-seatbelt'
    || summary.workspaceWrite.exitCode !== 0
    || !summary.workspaceWrite.fileCreated
    || summary.outsideWrite.exitCode === 0
    || summary.outsideWrite.fileCreated
    || summary.deniedSecretRead.exitCode === 0
    || summary.deniedSecretRead.stdout
    || summary.deniedNetwork.exitCode === 0
    || summary.allowlistedNetwork.exitCode !== 0
    || !summary.allowlistedNetwork.stdoutPrefix.includes('<!doctype html>')
    || summary.nonAllowlistedNetwork.exitCode === 0
    || summary.fullNetwork.exitCode !== 0
    || !summary.fullNetwork.stdoutPrefix.includes('<!doctype html>')
    || summary.fileOffNetworkSplit.outsideReadExitCode !== 0
    || summary.fileOffNetworkSplit.outsideReadStdout !== 'classified'
    || summary.fileOffNetworkSplit.outsideWriteExitCode !== 0
    || summary.fileOffNetworkSplit.outsideWriteStdout !== 'file-off'
    || !summary.fileOffNetworkSplit.outsideWriteCreated
    || summary.fileOffNetworkSplit.blockedNetworkExitCode === 0
    || summary.fileOffNetworkSplit.allowlistedNetworkExitCode !== 0
    || !summary.fileOffNetworkSplit.allowlistedNetworkStdoutPrefix.includes('<!doctype html>')
    || summary.fileOffNetworkSplit.nonAllowlistedNetworkExitCode === 0
    || summary.fileOffNetworkSplit.fullNetworkExitCode !== 0
    || !summary.fileOffNetworkSplit.fullNetworkStdoutPrefix.includes('<!doctype html>')
    || summary.readOnly.workspaceReadExitCode !== 0
    || summary.readOnly.workspaceReadStdout !== 'inside-file'
    || summary.readOnly.workspaceWriteExitCode === 0
    || summary.readOnly.workspaceWriteCreated
    || summary.readOnly.networkExitCode !== 0
    || !summary.readOnly.networkStdoutPrefix.includes('<!doctype html>')
    || summary.temporaryDirectoryWrite.exitCode === 0
    || summary.temporaryDirectoryWrite.fileCreated
  ) {
    throw new Error('macOS Seatbelt smoke test failed')
  }
} finally {
  rmSync(smokeRoot, { recursive: true, force: true })
  rmSync(tmpWrite, { force: true })
}
