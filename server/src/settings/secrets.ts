import { SECRET_REFS, type SecretRef, type SecretStatus } from '../../../shared/settings';
import { nowIso, type Db } from '../db';
import { open, seal } from '../crypto';

/** Encrypted secret storage. Values never leave the server through the API. */
export class SecretStore {
  constructor(
    private db: Db,
    private key: Buffer,
  ) {}

  set(ref: SecretRef, value: string, actor: string) {
    const s = seal(value, this.key, ref);
    this.db
      .prepare(
        `INSERT INTO secrets (ref, ciphertext, iv, tag, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (ref) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(ref, s.ciphertext, s.iv, s.tag, nowIso(), actor);
  }

  get(ref: SecretRef): string | undefined {
    const row = this.db.prepare('SELECT ciphertext, iv, tag FROM secrets WHERE ref = ?').get(ref) as
      | { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }
      | undefined;
    if (!row) return undefined;
    return open({ ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), tag: Buffer.from(row.tag) }, this.key, ref);
  }

  clear(ref: SecretRef) {
    this.db.prepare('DELETE FROM secrets WHERE ref = ?').run(ref);
  }

  status(): Record<SecretRef, SecretStatus> {
    const rows = this.db.prepare('SELECT ref, updated_at FROM secrets').all() as { ref: string; updated_at: string }[];
    const found = new Map(rows.map((r) => [r.ref, r.updated_at]));
    return Object.fromEntries(
      SECRET_REFS.map((ref) => [ref, found.has(ref) ? { set: true, updatedAt: found.get(ref) } : { set: false }]),
    ) as Record<SecretRef, SecretStatus>;
  }
}
