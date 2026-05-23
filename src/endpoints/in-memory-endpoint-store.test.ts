import { describe, expect, it } from "vitest";
import { describeEndpointStoreContract } from "./conformance.js";
import { InMemoryEndpointStore } from "./in-memory-endpoint-store.js";

describeEndpointStoreContract(
  "InMemoryEndpointStore",
  (options) => new InMemoryEndpointStore(options),
);

describe("InMemoryEndpointStore — extras", () => {
  it("reports size as the count of live endpoints", async () => {
    const store = new InMemoryEndpointStore();
    expect(store.size).toBe(0);
    const a = await store.create({ appId: "app_1", url: "https://x.test/a" });
    await store.create({ appId: "app_1", url: "https://x.test/b" });
    expect(store.size).toBe(2);
    await store.delete(a.id);
    expect(store.size).toBe(1);
  });

  it("generates a unique secret per created endpoint by default", async () => {
    const store = new InMemoryEndpointStore();
    const a = await store.create({ appId: "app_1", url: "https://x.test/a" });
    const b = await store.create({ appId: "app_1", url: "https://x.test/b" });
    expect(a.secret).not.toBe(b.secret);
    expect(a.secret.startsWith("whsec_")).toBe(true);
  });
});
