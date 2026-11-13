# Codex apply-patch source

- Upstream: https://github.com/openai/codex
- Pinned commit: `ed8eac40832e6a79f30eaeb3c521912f231d43eb`
- Unmodified sources: all Rust files in `src/` from `codex-rs/apply-patch/src/`, except `src/bin/ccm-bridge.rs` (new).
- Unmodified URI sources: all Rust files in `path-uri/src/` from `codex-rs/utils/path-uri/src/`.
- License: Apache-2.0; the corresponding upstream license is `third_party/openai-codex/LICENSE`.

`Cargo.toml` and `path-uri/Cargo.toml` are standalone dependency manifests
for the unchanged sources. `exec-server/` implements only the upstream
file-system trait methods required by apply-patch, with the existing CCM
workspace restriction checked at the Worker boundary. This is deliberately
not a copy or reimplementation of the complete upstream Codex exec-server.

Only `src/bin/ccm-bridge.rs` implements the JSON request/response transport
between the CCM Worker and the Codex patch crate. The patch parser, matching,
line-ending preservation, ordered file mutations, and delta tracking stay in
the upstream files; do not add a parallel patch engine.
