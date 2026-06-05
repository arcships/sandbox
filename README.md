# Arcships Sandbox Runner

This repository builds the native `dim-sandbox-runner` payload consumed by Dim Agent.

The runner exposes Dim's JSON protocol at the process boundary and reuses pinned native sandbox components from the `third_party/openai-codex` submodule.

## Repository Role

- Own the native Rust runner source.
- Pin the upstream Codex sandbox implementation used by the runner.
- Build per-platform native payloads in GitHub Actions.
- Publish runner payloads as CI artifacts or release assets for `dim-agent` packaging.

`dim-agent` should consume these built artifacts. It should not need to compile every native platform during CLI or Desktop release.

## Layout

```text
native/
  Cargo.toml
  runner/                 # dim-sandbox-runner
  scripts/                # build and smoke verification scripts
third_party/openai-codex  # pinned git submodule
```

## Clone

```bash
git clone https://github.com/arcships/sandbox.git
cd sandbox
git submodule update --init --recursive
```

## Build Locally

```bash
pnpm native:check
pnpm native:build
pnpm native:protocol
pnpm native:smoke
```

The build script is intentionally OS-native:

- macOS builds macOS payloads.
- Linux builds Linux payloads.
- Windows builds Windows payloads.

This keeps platform-specific sandbox helpers and signing behavior explicit.

## Artifact Contract

Each platform artifact should contain the complete runtime payload under `runtime/sandbox/`:

```text
runtime/sandbox/
  dim-sandbox-runner
  codex-linux-sandbox              # Linux only
  codex-command-runner.exe         # Windows only
  codex-windows-sandbox-setup.exe  # Windows only
  codex-resources/                 # platform helper resources
```

`dim-agent` packaging downloads the matching platform artifact and places it next to the CLI binary or inside the Desktop app resources.

