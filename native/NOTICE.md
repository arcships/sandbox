# Native Runner Notice

`native/runner` integrates sandbox logic from the OpenAI Codex project.
The upstream source is pinned as the `third_party/openai-codex` git submodule.

Upstream:

- Repository: https://github.com/openai/codex
- Pinned revision: `c83ba22359f4140e44fc43500d2bedbb882d7211`
- License: Apache-2.0

This repository owns the runner's JSON protocol, policy mapping, and native payload packaging.
Application adapters are separate consumers of that protocol; this repository does not include the Dim Agent TypeScript packages.
Codex crate APIs remain behind the native runner process boundary.
