# Runner JSON Protocol v1

Source of truth: [native/runner/src/main.rs](../native/runner/src/main.rs). See the [usage guide](usage.md) for runnable examples and integration diagrams.

## Transport

Start `dim-sandbox-runner run` (`.exe` on Windows), send one UTF-8 JSON object on stdin, and close stdin. The runner reads until EOF, executes one command, emits one JSON result on stdout, and exits. A trailing newline alone does not end a request. This is a one-shot process protocol, not a JSONL service or an interactive terminal.

`run` is the invocation convention used by the scripts. The current binary does not parse CLI arguments or provide `--help`; its input is the JSON document on stdin. Standard output/error from the target command is captured inside the result rather than streamed directly to the caller. There is no request field for sending stdin data to the target command.

## Request

JSON field names use camelCase. Unknown fields are currently ignored; adding a field does not mean the runner implements it. Optional arrays and `env` accept omission, not `null`.

| Field | Type | Required / default | Meaning |
| --- | --- | --- | --- |
| `version` | integer | Required, must be `1` | Protocol version |
| `requestId` | string | Required | Returned unchanged for correlation |
| `command` | string array | Required, nonempty | Executable followed by arguments; no implicit shell |
| `cwd` | string | Required | Target command's working directory |
| `env` | string-to-string object | Defaults to `{}` | Target environment; see environment behavior below |
| `policy` | object | Required | Permissions defined below |
| `timeoutMs` | nonnegative integer or `null` | Optional | Forwarded on the Windows restricted-token path only; host must enforce deadlines |

Pass absolute paths for `cwd`, `workspaceRoot`, roots, and the executable. Create the working directory before invoking the runner. The runner does not validate that `cwd` or configured roots are contained by `workspaceRoot`; the trusted host must choose and validate them. Relative roots are resolved against the runner process's working directory, not `workspaceRoot`. An executable installed outside readable roots may need its binary and runtime dependencies explicitly allowed.

### Policy

| Field | Type | Required / default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | Required | `false` runs directly and bypasses both filesystem and network policy |
| `mode` | string | Required | `read-only`, `workspace-write`, `off`, or `danger-full-access` |
| `workspaceRoot` | string | Required | Fallback root and base for relative literal deny paths |
| `readableRoots` | string array | Defaults to `[]` | For restricted modes, empty means use `workspaceRoot`; necessary system reads are also included |
| `writableRoots` | string array | Defaults to `[]` | For `workspace-write`, empty means use `workspaceRoot`; ignored by `read-only` |
| `readDenyPaths` | string array | Defaults to `[]` | Explicit deny paths/patterns in restricted modes; no built-in secret list |
| `allowedDomains` | string array | Defaults to `[]` | Network selector described below |

`read-only` permits configured reads and no writable roots. `workspace-write` permits configured reads and writes; writable roots also permit reads. In particular, `writableRoots: []` does not mean "deny writes". `off` and `danger-full-access` have the same filesystem meaning here: full file access, ignoring roots and deny paths. They still use `allowedDomains` when `enabled` is true. Full file access combined with `"*"` takes the direct execution path.

Literal `readDenyPaths` are relative to `workspaceRoot` unless absolute. `~` and `~/` expand using the runner's environment. Entries containing `*` take the glob path; relative patterns gain a `**/` prefix unless already present, so they are not scoped only to the workspace. Use explicit absolute paths or patterns such as `**/.env` to avoid ambiguous matching. For other paths, provide explicit absolute paths rather than relying on home expansion. See Windows limitations below before relying on read restrictions.

### Network selection

| `allowedDomains` | Requested behavior |
| --- | --- |
| `[]` | Restricted network, no managed proxy started |
| A nonempty list without `"*"` | Start a managed proxy with this domain allowlist and pass its settings to the command |
| Any list containing `"*"` | Network enabled, no managed proxy started |

The managed proxy disables SOCKS5 UDP and upstream proxy chaining. This API describes domain-based access; it does not expose a general protocol, port, or IP firewall configuration. Actual enforcement depends on the platform path below.

### Environment behavior

For the macOS/Linux transformed sandbox path, the child environment is cleared, populated from `env`, and augmented with managed proxy settings when applicable. The runner does not filter caller-supplied credentials. Supply an explicit allowlist in the host, as the [Node example](../examples/run-command.mjs) does.

Direct execution inherits the runner environment and overlays `env`; `env: {}` therefore does not sanitize a disabled/full-access command. The Windows file-mode-off path also executes directly after applying proxy/offline variables. The Windows restricted-token backend receives the requested environment and any managed proxy settings.

The runner's own environment is separate from request `env`. `DIM_CODEX_LINUX_SANDBOX` can override the Linux helper path; otherwise it is found beside the runner. `DIM_SANDBOX_CODEX_HOME` controls Windows sandbox state; its default is `<workspaceRoot>/.dim-sandbox/codex-home`.

## Result

Normal completion writes one JSON object with these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer | Always `1` |
| `requestId` | string | Request identifier |
| `command` | string array | Requested argv |
| `cwd` | string | Requested working directory |
| `stdout`, `stderr` | string | Buffered target output, decoded as lossy UTF-8 |
| `exitCode` | integer or `null` | Target exit code; may be null when terminated by a Unix signal |
| `signal` | string or `null` | Unix signal number represented as a string, otherwise null |
| `timedOut` | boolean | Currently always `false`; not a reliable deadline indicator |
| `wallTimeMs` | integer | Elapsed execution time after parsing, including proxy and sandbox setup |
| `backend` | string | OS-derived backend label, including when execution was direct |
| `diagnostics` | array | Reserved diagnostic entries; currently emitted as `[]` |

Backend labels are `codex-derived-macos-seatbelt`, `codex-derived-linux-bwrap`, and `codex-derived-windows-restricted-token`. A label is not proof that restrictions were enabled.

### Failure handling

Distinguish these outcomes in the host:

1. Runner process exits `0` and emits a result: inspect the target's `exitCode` and `signal`. A denied file/network operation usually appears as a nonzero target code and target stderr.
2. Runner process exits `1`: inspect runner stderr. Malformed requests, unsupported versions, policy transformation errors, or launch failures may produce no JSON result.
3. Host deadline/cancellation or process signal: perform process-tree cleanup and record the host's own timeout/cancellation status; a complete result may not exist.

Version validation and nonempty-command validation are explicit. This is not a complete policy validation service: the host must construct trusted permissions, validate paths, and treat backend failures as errors rather than retrying the same command without isolation.

## Platform and Runtime Limitations

| Area | Current implementation |
| --- | --- |
| macOS | Seatbelt wraps the target command; managed network policy is passed to the platform transform. |
| Linux | Requires `codex-linux-sandbox`, staged `codex-resources/bwrap`, and usable user namespaces. GNU-target release payloads are not a guarantee of musl/Alpine compatibility. WSL1 is unsupported. |
| Windows restricted mode | Converts to a legacy policy that preserves write restrictions but not `readableRoots`/`readDenyPaths`. Do not rely on secret-read isolation. |
| Windows file mode `off` / `danger-full-access` | Executes directly. Network restrictions are proxy/offline environment settings; a program that ignores them can bypass those settings. |
| Timeouts | macOS/Linux and direct paths do not enforce `timeoutMs`; Windows restricted mode forwards it, but `timedOut` is still always false. Host enforcement is required. |
| Output and resources | Output is buffered in runner memory with no configured size limit. No streaming/PTY or CPU/memory quota interface is implemented. |
| Host application | Only launched command processes receive OS restrictions. Direct host file/network APIs require separate host-side permission checks. |

The Linux hosted CI smoke permits specified namespace setup failures when `--allow-host-sandbox-unavailable` is supplied. A successful CI run therefore does not by itself demonstrate working Linux isolation on a deployment machine. The Windows smoke explicitly omits read-isolation assertions. Verify the policies you need on the actual deployment platform using the strict smoke invocation in the [usage guide](usage.md#6-验证接入).
