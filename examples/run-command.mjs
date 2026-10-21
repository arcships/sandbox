import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

// Minimal protocol example; only the requested child command is sandboxed.
const usage = 'Usage: node examples/run-command.mjs <runner-path> <workspace> <command> [args...]'

async function main() {
  const [runnerArg, workspaceArg, ...command] = process.argv.slice(2)
  if (!runnerArg || !workspaceArg || command.length === 0) throw new Error(usage)

  const runnerPath = await realpath(resolve(runnerArg))
  const workspace = await realpath(resolve(workspaceArg))
  if (!(await stat(workspace)).isDirectory()) throw new Error('workspace must be an existing directory')

  const envKeys = [
    'PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT',
    'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  ]
  const env = Object.fromEntries(
    envKeys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  )
  const request = {
    version: 1,
    requestId: randomUUID(),
    command,
    cwd: workspace,
    env,
    policy: {
      enabled: true,
      mode: 'workspace-write',
      workspaceRoot: workspace,
      readableRoots: [workspace],
      writableRoots: [workspace],
      readDenyPaths: ['**/.env', '**/.env.*'],
      allowedDomains: [],
    },
  }

  const result = await invoke(runnerPath, request)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  // The runner can exit successfully while the inner command exits nonzero.
  process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1
}

function invoke(runnerPath, request) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(runnerPath, ['run'], {
      // Trusted runner/helpers inherit host env; target command gets request.env.
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let stdinError
    let expired = false
    const watchdog = setTimeout(() => {
      expired = true
      killTree(child)
    }, 30_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.stdin.on('error', (error) => { stdinError = error })
    child.once('error', (error) => {
      clearTimeout(watchdog)
      reject(new Error(`runner could not start: ${error.message}`))
    })
    child.once('close', (code, signal) => {
      clearTimeout(watchdog)
      if (expired) return reject(new Error('host watchdog stopped the runner after 30 seconds'))
      if (code !== 0) {
        return reject(new Error(`runner failed (exit ${code}, signal ${signal}): ${stderr.trim()}`))
      }
      if (stdinError) return reject(new Error(`runner request failed: ${stdinError.message}`))
      try {
        const result = JSON.parse(stdout)
        if (result.version !== 1 || result.requestId !== request.requestId) {
          throw new Error('response version or requestId mismatch')
        }
        resolveResult(result)
      } catch (error) {
        reject(new Error(`invalid runner response: ${error.message}`))
      }
    })
    // Runner v1 reads stdin to EOF before parsing, so end() is required.
    child.stdin.end(JSON.stringify(request))
  })
}

function killTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', timeout: 5_000, windowsHide: true,
    })
    if (killed.status !== 0) child.kill('SIGKILL')
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill('SIGKILL')
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
