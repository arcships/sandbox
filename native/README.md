# dim-sandbox native runner

This workspace contains the native process isolation runner used by `@archships/dim-sandbox-node`.

The runner intentionally exposes Dim's own JSON protocol instead of Codex internals:

```text
@archships/dim-sandbox-node
  -> NativeRunnerRequest
  -> dim-sandbox-runner
  -> Codex-derived platform backend
```

Current integration points:

- macOS: Codex `codex-sandboxing` Seatbelt transform.
- Linux: Codex `codex-sandboxing` transform plus the `codex-linux-sandbox` helper.
- Windows: Codex `codex-windows-sandbox` legacy/elevated backend hook point.

Codex is checked in as the `third_party/openai-codex` git submodule. Run this after cloning:

```bash
git submodule update --init --recursive
```

Build:

```bash
pnpm native:check
pnpm native:build
pnpm sandbox:native:protocol
pnpm sandbox:native:smoke
pnpm sandbox:native:smoke:macos
```

Prerequisite: install the Rust toolchain so `cargo` is available.

Build an explicit platform/architecture artifact:

```bash
pnpm sandbox:native:build:platform -- --platform darwin --arch arm64
pnpm sandbox:native:build:platform -- --platform darwin --arch x64
pnpm sandbox:native:build:platform -- --platform linux --arch x64
pnpm sandbox:native:build:platform -- --platform win32 --arch x64
```

The build script never cross-builds across operating systems. It always passes an explicit Rust target triple, so a host-architecture binary cannot be mislabeled as an Intel/ARM package. Linux builds also stage `codex-linux-sandbox` and a validated `bwrap` resource. Windows builds stage `codex-command-runner.exe` and `codex-windows-sandbox-setup.exe`.

`native/Cargo.lock` is committed on purpose because this workspace builds a binary and needs to keep transitive Codex dependency versions reproducible. Keep the tungstenite patches in `native/Cargo.toml` aligned with `third_party/openai-codex/codex-rs/Cargo.toml`.

The Desktop release pipeline packages the Linux and Windows helpers next to `dim-sandbox-runner`. The runtime manifest records the host protocol version and a SHA-256 digest for every required binary. `pnpm --dir packages/desktop verify:runtime:sandbox:compat` executes the staged runner protocol handshake and rejects incompatible or incomplete update payloads.

The macOS smoke test verifies workspace writes, sibling-directory write denial, explicit secret read denial, system temporary-directory write denial, blocked network access, domain allowlist access through the managed proxy, non-allowlisted domain denial, and full network access.
