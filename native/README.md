# Native Runner Development

For standalone usage and application integration, start with the [usage guide](../docs/usage.md) and [protocol reference](../docs/protocol.md). This directory builds the native binary and platform helpers; application adapters live outside this repository.

## Prerequisites

- Git, including the initialized `third_party/openai-codex` submodule.
- Node.js 20+ for build and verification scripts; CI uses Node.js 22.
- Rust/Cargo and a native C/C++ linker; CI installs the stable toolchain.
- macOS: Xcode Command Line Tools.
- Linux: bubblewrap, C/C++ build tools, pkg-config, OpenSSL development headers, and Perl. CI builds on Ubuntu 24.04 using GNU targets.
- Windows: Visual Studio Build Tools with the MSVC C++ toolchain and Windows SDK.
- pnpm for the command aliases below; scripts can also be invoked directly with Node.js. There are no npm dependencies to install.

## Build

Run from the repository root:

```bash
git submodule update --init --recursive
node native/scripts/patch-codex-submodule.mjs
pnpm native:check
pnpm native:build
pnpm native:protocol
pnpm native:smoke
```

The ConPTY compatibility patch is idempotent and is needed before checking Windows source. The Windows build script also applies it automatically. It modifies the pinned submodule worktree, not its recorded commit.

The output directory is `native/target/release/`, including required helpers. Explicit platform/architecture builds use these commands on their respective operating systems:

```bash
pnpm native:build:platform -- --platform darwin --arch arm64
pnpm native:build:platform -- --platform darwin --arch x64
pnpm native:build:platform -- --platform linux --arch arm64
pnpm native:build:platform -- --platform linux --arch x64
pnpm native:build:platform -- --platform win32 --arch x64
```

The script passes an explicit Rust target triple and rejects cross-OS builds. Windows ARM64 has a target mapping but no CI/release coverage. Linux builds copy the installed `bwrap` into `codex-resources/bwrap`; copying it does not remove its dynamic library requirements. Keep the complete payload layout described in the [root README](../README.md#artifact-contract).

## Verify

| Command | Coverage |
| --- | --- |
| `pnpm native:protocol` | Protocol v1 execution and unsupported-version rejection; sandbox disabled |
| `pnpm native:smoke` | Platform read/write/network checks; Windows omits read-isolation assertions |
| `pnpm native:smoke:macos` | Additional macOS policy combinations and system temp write denial |
| `pnpm native:smoke:wsl` | Invokes Linux build/protocol/smoke inside the selected WSL distribution; requires WSL2 |

Network smoke checks need curl and reachable `example.com` / `www.iana.org` for allowed-network cases. Protocol checks do not need external network access. Test an extracted payload directly with:

```bash
node native/scripts/protocol-compat.mjs /absolute/path/runtime/sandbox/dim-sandbox-runner
node native/scripts/smoke-platform.mjs /absolute/path/runtime/sandbox/dim-sandbox-runner
```

Use `.exe` on Windows. Linux hosted CI adds `--allow-host-sandbox-unavailable` to accept specified namespace setup failures. Deployment verification should use the strict invocation above. Current platform and lifecycle limitations are maintained in the [protocol reference](../docs/protocol.md#platform-and-runtime-limitations).

## Dependencies and Releases

`native/Cargo.lock` is committed because this workspace produces a binary. Keep tungstenite patches in `native/Cargo.toml` aligned with the pinned Codex workspace. Review the ConPTY compatibility patch when updating the submodule.

GitHub Actions builds five platform payloads. A `v*` tag publishes `.tar.gz`/`.zip` archives and `SHA256SUMS`. Each archive starts with `<platform>/runtime/sandbox/`. The workflow does not perform code signing or notarization.
