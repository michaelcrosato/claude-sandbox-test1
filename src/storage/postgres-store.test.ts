import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { createPostgresPool } from "../db/postgres.js";
import { PostgresMessageStore } from "./postgres-store.js";
import { describeMessageStoreContract } from "./conformance.js";

const pgUrl = process.env.POSTHORN_TEST_PG_URL;

if (!pgUrl) {
  describe.skip("PostgresMessageStore — skipped (POSTHORN_TEST_PG_URL not set)", () => {});
} else {
  const pool = createPostgresPool(pgUrl);
  const lifecycle = new PostgresMessageStore(pool);

  beforeAll(async () => {
    await lifecycle.initialize();
  });

  beforeEach(async () => {
    await lifecycle.truncate();
  });

  afterAll(async () => {
    await pool.end();
  });

  describeMessageStoreContract(
    "PostgresMessageStore",
    (options) => new PostgresMessageStore(pool, options),
  );
}
