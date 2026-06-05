# Native Runner Notice

`native/runner` integrates sandbox logic from the OpenAI Codex project.
The upstream source is pinned as the `third_party/openai-codex` git submodule.

Upstream:

- Repository: https://github.com/openai/codex
- Pinned revision: `c83ba22359f4140e44fc43500d2bedbb882d7211`
- License: Apache-2.0

The Dim-facing protocol, policy mapping, packaging, and Node adapter are owned by `dim-sandbox`.
Codex crate APIs are kept behind the native runner boundary and should not leak into `@archships/dim-sandbox-core` or `@archships/dim-sandbox-node`.
