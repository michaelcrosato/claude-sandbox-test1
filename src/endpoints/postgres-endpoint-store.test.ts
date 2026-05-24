import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { createPostgresPool } from "../db/postgres.js";
import { PostgresEndpointStore } from "./postgres-endpoint-store.js";
import { describeEndpointStoreContract } from "./conformance.js";

const pgUrl = process.env.POSTHORN_TEST_PG_URL;

if (!pgUrl) {
  describe.skip("PostgresEndpointStore — skipped (POSTHORN_TEST_PG_URL not set)", () => {});
} else {
  const pool = createPostgresPool(pgUrl);
  const lifecycle = new PostgresEndpointStore(pool);

  beforeAll(async () => {
    await lifecycle.initialize();
  });

  beforeEach(async () => {
    await lifecycle.truncate();
  });

  afterAll(async () => {
    await pool.end();
  });

  describeEndpointStoreContract(
    "PostgresEndpointStore",
    (options) => new PostgresEndpointStore(pool, options),
  );
}
