import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { createPostgresPool } from "../db/postgres.js";
import { PostgresAppStore } from "./postgres-app-store.js";
import { describeAppStoreContract } from "./conformance.js";

const pgUrl = process.env.POSTHORN_TEST_PG_URL;

if (!pgUrl) {
  describe.skip("PostgresAppStore — skipped (POSTHORN_TEST_PG_URL not set)", () => {});
} else {
  const pool = createPostgresPool(pgUrl);
  const lifecycle = new PostgresAppStore(pool);

  beforeAll(async () => {
    await lifecycle.initialize();
  });

  beforeEach(async () => {
    await lifecycle.truncate();
  });

  afterAll(async () => {
    await pool.end();
  });

  describeAppStoreContract(
    "PostgresAppStore",
    (options) => new PostgresAppStore(pool, options),
  );
}
