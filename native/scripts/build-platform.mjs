import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const nativeRoot = join(repoRoot, 'native')
const codexRoot = join(repoRoot, 'third_party', 'openai-codex', 'codex-rs')
const outputRoot = join(nativeRoot, 'target', 'release')
const args = process.argv.slice(2)

const readOption = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const platform = readOption('--platform', process.platform)
const arch = readOption('--arch', process.arch)

const targetTriples = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'linux:arm64': 'aarch64-unknown-linux-gnu',
  'linux:x64': 'x86_64-unknown-linux-gnu',
  'win32:arm64': 'aarch64-pc-windows-msvc',
  'win32:x64': 'x86_64-pc-windows-msvc',
}

const key = `${platform}:${arch}`
const target = targetTriples[key]
if (!target) {
  throw new Error(`unsupported native sandbox target: ${key}`)
}
if (platform !== process.platform) {
  throw new Error(
    `cross-OS native sandbox builds are unsupported: host=${process.platform}, target=${platform}`,
  )
}

const executableName = (name) => platform === 'win32' ? `${name}.exe` : name

const run = (command, commandArgs, options = {}) => {
  const child = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  })
  if (child.status !== 0) {
    const reason = child.error
      ? `${child.error.name}: ${child.error.message}`
      : child.signal
        ? `signal ${child.signal}`
        : `exit code ${String(child.status)}`
    throw new Error(`${command} ${commandArgs.join(' ')} failed with ${reason}`)
  }
}

const commandSucceeds = (command, commandArgs) => {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'ignore',
  }).status === 0
}

const copyArtifact = (source, targetPath) => {
  if (!existsSync(source)) {
    throw new Error(`native sandbox build artifact is missing: ${source}`)
  }
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(source, targetPath)
  if (platform !== 'win32') {
    chmodSync(targetPath, 0o755)
  }
  console.log(`[native-build] staged ${source}`)
  console.log(`[native-build] target ${targetPath}`)
}

if (commandSucceeds('rustup', ['--version'])) {
  run('rustup', ['target', 'add', target])
} else {
  console.log(`[native-build] rustup is unavailable; using the installed Rust toolchain for ${target}`)
}
run('cargo', [
  'build',
  '--manifest-path',
  join(nativeRoot, 'Cargo.toml'),
  '--release',
  '--target',
  target,
  '-p',
  'dim-sandbox-runner',
])

copyArtifact(
  join(nativeRoot, 'target', target, 'release', executableName('dim-sandbox-runner')),
  join(outputRoot, executableName('dim-sandbox-runner')),
)

if (platform === 'linux') {
  run('cargo', [
    'build',
    '--manifest-path',
    join(codexRoot, 'Cargo.toml'),
    '--release',
    '--target',
    target,
    '-p',
    'codex-linux-sandbox',
  ])
  copyArtifact(
    join(codexRoot, 'target', target, 'release', 'codex-linux-sandbox'),
    join(outputRoot, 'codex-linux-sandbox'),
  )

  const bwrap = spawnSync('sh', ['-lc', 'command -v bwrap'], { encoding: 'utf8' }).stdout.trim()
  if (!bwrap) {
    throw new Error('bubblewrap is required to build a self-contained Linux sandbox package')
  }
  copyArtifact(bwrap, join(outputRoot, 'codex-resources', 'bwrap'))
}

if (platform === 'win32') {
  run('cargo', [
    'build',
    '--manifest-path',
    join(codexRoot, 'Cargo.toml'),
    '--release',
    '--target',
    target,
    '-p',
    'codex-windows-sandbox',
    '--bin',
    'codex-command-runner',
    '--bin',
    'codex-windows-sandbox-setup',
  ])
  copyArtifact(
    join(codexRoot, 'target', target, 'release', 'codex-command-runner.exe'),
    join(outputRoot, 'codex-command-runner.exe'),
  )
  copyArtifact(
    join(codexRoot, 'target', target, 'release', 'codex-windows-sandbox-setup.exe'),
    join(outputRoot, 'codex-windows-sandbox-setup.exe'),
  )
}

console.log(`[native-build] completed platform=${platform} arch=${arch} target=${target}`)
