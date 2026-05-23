import { describe, expect, it } from "vitest";
import { describeAppStoreContract } from "./conformance.js";
import { InMemoryAppStore } from "./in-memory-app-store.js";

describeAppStoreContract(
  "InMemoryAppStore",
  (options) => new InMemoryAppStore(options),
);

describe("InMemoryAppStore — extras", () => {
  it("reports size as the count of live apps", async () => {
    const store = new InMemoryAppStore();
    expect(store.size).toBe(0);
    const a = await store.create({ name: "a" });
    await store.create({ name: "b" });
    expect(store.size).toBe(2);
    await store.delete(a.id);
    expect(store.size).toBe(1);
  });

  it("generates a unique high-entropy secret per minted key by default", async () => {
    const store = new InMemoryAppStore();
    const app = await store.create();
    const k1 = await store.createApiKey(app.id);
    const k2 = await store.createApiKey(app.id);
    expect(k1.secret).not.toBe(k2.secret);
    expect(k1.secret.startsWith("phk_")).toBe(true);
    // Both authenticate to the same app.
    expect(await store.authenticate(k1.secret)).toEqual(app);
    expect(await store.authenticate(k2.secret)).toEqual(app);
  });

  it("never stores or lists the full plaintext secret (only a short prefix)", async () => {
    // With a realistic 40+ char secret, the 12-char display prefix exposes only
    // a fraction — the listed metadata must not contain the whole secret.
    const store = new InMemoryAppStore();
    const app = await store.create();
    const { secret } = await store.createApiKey(app.id);
    const listed = await store.listApiKeys(app.id);
    expect(JSON.stringify(listed)).not.toContain(secret);
  });
});
