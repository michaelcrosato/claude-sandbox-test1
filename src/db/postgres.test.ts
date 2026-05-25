import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPostgresPool,
  POSTGRES_IDLE_IN_TXN_TIMEOUT_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
} from "./postgres.js";

// Gated like every other Postgres suite: skipped unless a live database is
// reachable. Run locally with a throwaway container:
//   docker run -d --rm -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=posthorn_test -p 5455:5432 postgres:16
//   POSTHORN_TEST_PG_URL=postgres://postgres:pw@127.0.0.1:5455/posthorn_test npx vitest run src/db/postgres.test.ts
const pgUrl = process.env.POSTHORN_TEST_PG_URL;

if (!pgUrl) {
  describe.skip("createPostgresPool — skipped (POSTHORN_TEST_PG_URL not set)", () => {});
} else {
  describe("createPostgresPool connection timeouts", () => {
    const pool = createPostgresPool(pgUrl);

    afterAll(async () => {
      await pool.end();
    });

    it("opens every connection with Posthorn's lock + idle-in-transaction timeouts", async () => {
      // pg_settings reports both GUCs in their base unit (milliseconds), so the
      // numeric setting equals the constants the factory injected — confirming the
      // `-c …` startup options actually reached the backend.
      const { rows } = await pool.query<{ name: string; setting: string }>(
        "SELECT name, setting FROM pg_settings" +
          " WHERE name IN ('lock_timeout', 'idle_in_transaction_session_timeout')",
      );
      const ms = Object.fromEntries(rows.map((r) => [r.name, Number(r.setting)]));
      expect(ms.lock_timeout).toBe(POSTGRES_LOCK_TIMEOUT_MS);
      expect(ms.idle_in_transaction_session_timeout).toBe(POSTGRES_IDLE_IN_TXN_TIMEOUT_MS);
    });

    it(
      "cancels a statement blocked on a row lock within lock_timeout — never hangs forever",
      async () => {
        // Unique scratch table: the PG suites share one database, so a fixed name
        // could collide with a parallel run.
        const table = `lock_probe_${randomUUID().replace(/-/g, "")}`;
        await pool.query(`CREATE TABLE ${table} (id INT PRIMARY KEY)`);
        try {
          await pool.query(`INSERT INTO ${table} (id) VALUES (1)`);

          const holder = await pool.connect();
          const blocked = await pool.connect();
          try {
            // `holder` takes and keeps the row lock.
            await holder.query("BEGIN");
            await holder.query(`SELECT * FROM ${table} WHERE id = 1 FOR UPDATE`);

            // `blocked` wants the same lock. With the default lock_timeout = 0 this
            // would wait for `holder` indefinitely; the factory's finite timeout
            // turns it into a prompt, classifiable failure instead.
            await blocked.query("BEGIN");
            const start = Date.now();
            let code: string | undefined;
            try {
              await blocked.query(`SELECT * FROM ${table} WHERE id = 1 FOR UPDATE`);
              throw new Error("expected the blocked SELECT FOR UPDATE to be cancelled by lock_timeout");
            } catch (err) {
              code = (err as { code?: string }).code;
            }
            const elapsed = Date.now() - start;
            await blocked.query("ROLLBACK").catch(() => {});

            // 55P03 = lock_not_available ("canceling statement due to lock timeout").
            expect(code).toBe("55P03");
            // Bounds prove the timeout is genuinely in force: it neither returned
            // instantly (the default would *wait*, not fail) nor hung indefinitely.
            expect(elapsed).toBeGreaterThanOrEqual(POSTGRES_LOCK_TIMEOUT_MS * 0.5);
            expect(elapsed).toBeLessThan(POSTGRES_LOCK_TIMEOUT_MS * 2);
          } finally {
            await holder.query("ROLLBACK").catch(() => {});
            holder.release();
            blocked.release();
          }
        } finally {
          await pool.query(`DROP TABLE IF EXISTS ${table}`);
        }
      },
      POSTGRES_LOCK_TIMEOUT_MS * 3,
    );
  });
}
