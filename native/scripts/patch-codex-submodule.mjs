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

const before = '        self.con.raw_handle()\n'
const after = '        self.con.raw_handle() as RawHandle\n'

const source = readFileSync(conptyPath, 'utf8')
if (source.includes(after)) {
  console.log('[codex-patch] Windows ConPTY RawHandle patch already applied')
} else if (source.includes(before)) {
  writeFileSync(conptyPath, source.replace(before, after))
  console.log('[codex-patch] Applied Windows ConPTY RawHandle compatibility patch')
} else {
  throw new Error(`Codex ConPTY source did not match expected patch anchor: ${conptyPath}`)
}
