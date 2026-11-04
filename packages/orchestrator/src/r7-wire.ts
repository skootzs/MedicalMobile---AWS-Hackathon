/**
 * R7 wire-projection helpers shared by the COMPILE_LOGIC and VERIFY_BUILD
 * payload projections.
 *
 * R2 stores all internal hashes as raw 64-hex. R7's wire form prefixes them with
 * `sha256:` (handoffs.ts LOGIC_MODEL_HASH_PATTERN accepts both, but R2 emits the
 * explicit prefix for clarity). This conversion happens ONLY in the outbound
 * payload projection, at this single boundary.
 *
 * Contract version: R2 emits "1.0.0". R7's ACCEPTED_PAYLOAD_VERSIONS is
 * ['1.0.0','1.1.0'] and 1.1.0 only adds optional fields R2 does not own, so
 * emitting 1.0.0 is a deliberate, forward-compatible choice — NOT a stale value.
 */
export const R7_WIRE_CONTRACT_VERSION = '1.0.0' as const;

/** R2 raw hex -> R7's prefixed wire form, reconciled ONLY at the payload boundary. */
export const toR7Hash = (rawHex: string): string => `sha256:${rawHex}`;
