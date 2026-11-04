# Decisions

## Chromium in the verify stage: no capabilities, `--no-sandbox`

**Decision:** the harness and verify stages run with `--cap-drop ALL` and no added
capabilities, and Chromium starts with `--no-sandbox`.

Chromium's sandbox crashed under the original flags (`--cap-drop ALL --cap-add SYS_ADMIN`)
with `ChrootToSafeEmptyDir` and a zygote signal 6. `scripts/kiro/27-chromium-sandbox-matrix.sh`
started the real harness under five flag sets on the x86 Kiro workspace:

| Variant | Flags | Result |
|---|---|---|
| a | `--cap-drop ALL --cap-add SYS_ADMIN` | FAIL |
| b | a + `SYS_CHROOT`, `SETUID`, `SETGID` | PASS |
| c | Docker's default capabilities + `SYS_ADMIN` | PASS |
| d | `--cap-drop ALL`, Chromium `--no-sandbox` | PASS (chosen) |
| e | a + `seccomp=unconfined` (diagnostic only) | PASS |

**Why d:** zero capabilities is a smaller container risk than granting `SYS_ADMIN`, the
broadest capability Linux has. Giving up Chromium's own sandbox is acceptable here because of
what this container runs and holds:

- The input is trusted: forms our own deterministic compiler generated, not arbitrary web content.
- The container is offline (`--network none`).
- It runs as non-root (uid 1000) with a read-only root filesystem and a read-only `/project`.
- It holds no AWS credentials, no secrets and no Docker socket.

**Fallback:** variant b, if `--no-sandbox` ever becomes a problem. It keeps Chromium's sandbox
but needs four capabilities: remove the preload below and add them in `verifyArgs`
(`runner/launch-build.ts`).

**How it's applied:** neither R5's specs nor R6's verifier pass launch args to the harness, and
R7 doesn't change their packages. The image's `/harness-no-sandbox.cjs` is preloaded with
`node --require` and adds `--no-sandbox` whenever a harness starts. `run-verify.sh` does this
for the verifier, and scripts 21 and 25 do it through `NODE_OPTIONS`.
