import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { createPostgresPool } from "../db/postgres.js";
import { PostgresDeliveryAttemptStore } from "./postgres-attempt-store.js";
import { describeDeliveryAttemptStoreContract } from "./conformance.js";

const pgUrl = process.env.POSTHORN_TEST_PG_URL;

if (!pgUrl) {
  describe.skip("PostgresDeliveryAttemptStore — skipped (POSTHORN_TEST_PG_URL not set)", () => {});
} else {
  const pool = createPostgresPool(pgUrl);
  const lifecycle = new PostgresDeliveryAttemptStore(pool);

  beforeAll(async () => {
    await lifecycle.initialize();
  });

  beforeEach(async () => {
    await lifecycle.truncate();
  });

  afterAll(async () => {
    await pool.end();
  });

  describeDeliveryAttemptStoreContract(
    "PostgresDeliveryAttemptStore",
    (options) => new PostgresDeliveryAttemptStore(pool, options),
  );
}
