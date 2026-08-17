import { createHash } from "crypto"

/**
 * Deterministically maps an arbitrary string key to a non-negative integer.
 * HydraDB vertex ids must be non-negative integers (cypher-compat.md), so
 * every domain key here (a user id, a session index, an entity name) is
 * hashed down to one of these before it's used as {id: ...} in a pattern.
 *
 * Uses the first 6 bytes (48 bits) of a SHA-256 digest, comfortably within
 * Number.MAX_SAFE_INTEGER (2^53), so collisions are practically impossible
 * at hackathon dataset scale.
 */
export function stableId(key: string): number {
  const hash = createHash("sha256").update(key).digest()
  let value = 0
  for (let i = 0; i < 6; i++) {
    value = value * 256 + hash[i]
  }
  return value
}
