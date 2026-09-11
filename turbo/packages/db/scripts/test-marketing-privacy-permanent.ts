import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

interface Epochs {
  readonly advertising_epoch: string;
  readonly marketing_analytics_epoch: string;
}

// Compatibility boundary: a pre-receipt API writes only the original columns.
// Its withdrawal must invalidate receipts without knowing either epoch column.
export async function validatePermanentMarketingPrivacyState(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const id = randomUUID();
    const original = await client.query<Epochs>(
      `INSERT INTO privacy_choices (id, user_id, sale_sharing, advertising,
        marketing_analytics, source, policy_version, updated_at)
       VALUES ($1, $2, 'granted', 'granted', 'granted', 'explicit', '2026-09-10', now())
       RETURNING advertising_epoch, marketing_analytics_epoch`,
      [id, `privacy_migration_${id}`],
    );
    const captured = original.rows[0];
    assert.ok(captured);
    const withdrawn = await client.query<Epochs>(
      `UPDATE privacy_choices SET advertising = 'denied', revision = gen_random_uuid(), updated_at = now()
       WHERE id = $1 RETURNING advertising_epoch, marketing_analytics_epoch`,
      [id],
    );
    const denied = withdrawn.rows[0];
    assert.ok(denied);
    assert.notEqual(denied.advertising_epoch, captured.advertising_epoch);
    assert.equal(
      denied.marketing_analytics_epoch,
      captured.marketing_analytics_epoch,
    );
    const restored = await client.query<Epochs>(
      `UPDATE privacy_choices SET advertising = 'granted', revision = gen_random_uuid(), updated_at = now()
       WHERE id = $1 RETURNING advertising_epoch, marketing_analytics_epoch`,
      [id],
    );
    assert.deepEqual(
      restored.rows[0],
      denied,
      "opt-in cannot revive the old advertising epoch",
    );
    for (const [column, value] of [
      ["sale_sharing", "denied"],
      ["source", "gpc"],
      ["policy_version", "unsupported-policy"],
    ] as const) {
      await client.query(
        `UPDATE privacy_choices SET sale_sharing = 'granted', advertising = 'granted',
         marketing_analytics = 'granted', source = 'explicit', policy_version = '2026-09-10' WHERE id = $1`,
        [id],
      );
      const before = await client.query<Epochs>(
        "SELECT advertising_epoch, marketing_analytics_epoch FROM privacy_choices WHERE id = $1",
        [id],
      );
      const after = await client.query<Epochs>(
        `UPDATE privacy_choices SET ${column} = $2 WHERE id = $1 RETURNING advertising_epoch, marketing_analytics_epoch`,
        [id, value],
      );
      assert.notEqual(
        after.rows[0]?.advertising_epoch,
        before.rows[0]?.advertising_epoch,
      );
      assert.notEqual(
        after.rows[0]?.marketing_analytics_epoch,
        before.rows[0]?.marketing_analytics_epoch,
      );
    }
    console.log(
      "   Marketing privacy epochs reject old-writer withdrawal replay",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
