import { test, expect, describe } from "vitest";
import { systemEventTransportFrom } from "./src/system-events/index.js";
import { Transport } from "./src/worker/delivery-worker.js";

describe("systemEventTransportFrom manual test", () => {
  it("rejects when the underlying transport rejects", async () => {
    const transport: Transport = () => Promise.reject(new Error("boom"));
    const send = systemEventTransportFrom(transport, { timeoutMs: 5000 });
    await expect(
      send("https://ops.example/hook", { method: "POST", headers: {}, body: "{}" })
    ).rejects.toThrow("boom");
  });
});
