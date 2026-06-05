import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const conptyPath = join(
  repoRoot,
  'third_party',
  'openai-codex',
  'codex-rs',
  'utils',
  'pty',
  'src',
  'win',
  'conpty.rs',
)

const beforePattern = /^([ \t]*)self\.con\.raw_handle\(\)(\r?\n)/m
const afterPattern = /self\.con\.raw_handle\(\) as RawHandle/

const source = readFileSync(conptyPath, 'utf8')
if (afterPattern.test(source)) {
  console.log('[codex-patch] Windows ConPTY RawHandle patch already applied')
} else if (beforePattern.test(source)) {
  writeFileSync(conptyPath, source.replace(beforePattern, '$1self.con.raw_handle() as RawHandle$2'))
  console.log('[codex-patch] Applied Windows ConPTY RawHandle compatibility patch')
} else {
  throw new Error(`Codex ConPTY source did not match expected patch anchor: ${conptyPath}`)
}
