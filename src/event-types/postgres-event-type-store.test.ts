import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { createPostgresPool } from "../db/postgres.js";
import { PostgresEventTypeStore } from "./postgres-event-type-store.js";
import { describeEventTypeStoreContract } from "./conformance.js";

const pgUrl = process.env.POSTHORN_TEST_PG_URL;

if (!pgUrl) {
  describe.skip("PostgresEventTypeStore — skipped (POSTHORN_TEST_PG_URL not set)", () => {});
} else {
  const pool = createPostgresPool(pgUrl);
  const lifecycle = new PostgresEventTypeStore(pool);

  beforeAll(async () => {
    await lifecycle.initialize();
  });

  beforeEach(async () => {
    await lifecycle.truncate();
  });

  afterAll(async () => {
    await pool.end();
  });

  describeEventTypeStoreContract(() => new PostgresEventTypeStore(pool));
}
