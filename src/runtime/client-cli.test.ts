import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_USAGE, runClientCommand, type ClientCliDeps } from "./client-cli.js";
import { PosthornApiError, PosthornError, PosthornTimeoutError } from "../sdk/client.js";
import type { PosthornClient } from "../sdk/client.js";

/**
 * A test rig: a fully-faked {@link PosthornClient} (every method the CLI can reach is
 * a `vi.fn` returning a deterministic fixture so output is byte-stable), output/error
 * capture buffers, and a counter that records how many times the `makeClient` factory
 * was invoked — the lever that proves help/unknown commands never build a client.
 */
type FakeClient = {
  health: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  listEndpoints: ReturnType<typeof vi.fn>;
  createEndpoint: ReturnType<typeof vi.fn>;
  getEndpoint: ReturnType<typeof vi.fn>;
  deleteEndpoint: ReturnType<typeof vi.fn>;
  testEndpoint: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
  listEventTypes: ReturnType<typeof vi.fn>;
  getUsage: ReturnType<typeof vi.fn>;
};

function makeRig(): {
  fake: FakeClient;
  out: string[];
  err: string[];
  builds: () => number;
  json: () => unknown;
  run: (...args: string[]) => Promise<number>;
  runUnconfigured: (...args: string[]) => Promise<number>;
} {
  const fake: FakeClient = {
    health: vi.fn(async () => ({ status: "ok" })),
    sendMessage: vi.fn(async (input: { eventType: string; payload: unknown }) => ({
      message: { id: "msg_1", appId: "app_1", eventType: input.eventType, createdAt: 0 },
      deduplicated: false,
      fanout: {
        matched: 2,
        skippedDisabled: 0,
        skippedUnsubscribed: 0,
        skippedChannel: 0,
        skippedFiltered: 0,
      },
    })),
    listEndpoints: vi.fn(async () => [
      { id: "ep_1", url: "https://a.example/hook" },
      { id: "ep_2", url: "https://b.example/hook" },
    ]),
    createEndpoint: vi.fn(async (input: { url: string; eventTypes?: readonly string[] }) => ({
      id: "ep_new",
      url: input.url,
      eventTypes: input.eventTypes ?? null,
      secret: "whsec_minted_once",
    })),
    getEndpoint: vi.fn(async (id: string) => ({ id, url: "https://a.example/hook" })),
    deleteEndpoint: vi.fn(async () => undefined),
    testEndpoint: vi.fn(async (id: string) => ({ endpointId: id, delivered: true, status: 200 })),
    getMessage: vi.fn(async (id: string) => ({ id, eventType: "user.created", deliveries: [] })),
    listMessages: vi.fn(async () => ({ data: [{ id: "msg_1" }], nextCursor: null })),
    listEventTypes: vi.fn(async () => ({ data: [{ name: "user.created" }], nextCursor: null })),
    getUsage: vi.fn(async () => ({ used: 5, quota: 1000, periodStart: 0 })),
  };
  const out: string[] = [];
  const err: string[] = [];
  let builds = 0;

  const deps: ClientCliDeps = {
    makeClient: () => {
      builds++;
      return fake as unknown as PosthornClient;
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  // A factory that fails the way the shell does when POSTHORN_URL/API_KEY is unset.
  const unconfiguredDeps: ClientCliDeps = {
    makeClient: () => {
      builds++;
      throw new Error("POSTHORN_URL is not set — point it at the gateway");
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };

  return {
    fake,
    out,
    err,
    builds: () => builds,
    json: () => JSON.parse(out.join("\n")),
    run: (...args: string[]) => runClientCommand(args, deps),
    runUnconfigured: (...args: string[]) => runClientCommand(args, unconfiguredDeps),
  };
}

describe("runClientCommand", () => {
  let rig: ReturnType<typeof makeRig>;
  beforeEach(() => {
    rig = makeRig();
  });

  describe("help / usage", () => {
    it("prints usage and exits 0 for an explicit `help` — without building a client", async () => {
      expect(await rig.run("help")).toBe(0);
      expect(rig.out.join("\n")).toBe(CLIENT_USAGE);
      expect(rig.err).toEqual([]);
      expect(rig.builds()).toBe(0);
    });

    it("treats -h and --help the same as help", async () => {
      expect(await rig.run("-h")).toBe(0);
      expect(await rig.run("--help")).toBe(0);
      expect(rig.builds()).toBe(0);
    });

    it("prints usage but exits 1 when no command is given (a prompt, not success)", async () => {
      expect(await rig.run()).toBe(1);
      expect(rig.out.join("\n")).toBe(CLIENT_USAGE);
      expect(rig.builds()).toBe(0);
    });

    it("rejects an unknown command with exit 1 and usage on stderr, building no client", async () => {
      expect(await rig.run("frobnicate")).toBe(1);
      expect(rig.err.join("\n")).toContain('unknown command "frobnicate"');
      expect(rig.err.join("\n")).toContain("Usage:");
      expect(rig.builds()).toBe(0);
    });

    it("help works even when the client cannot be built (config-free)", async () => {
      expect(await rig.runUnconfigured("help")).toBe(0);
      expect(rig.out.join("\n")).toBe(CLIENT_USAGE);
      expect(rig.builds()).toBe(0); // the factory was never even invoked
    });
  });

  describe("health", () => {
    it("prints the probe result as JSON", async () => {
      expect(await rig.run("health")).toBe(0);
      expect(rig.fake.health).toHaveBeenCalledOnce();
      expect(rig.json()).toEqual({ status: "ok" });
    });
  });

  describe("send", () => {
    it("requires an event type", async () => {
      expect(await rig.run("send")).toBe(1);
      expect(rig.err.join("\n")).toContain("requires an <eventType>");
      expect(rig.fake.sendMessage).not.toHaveBeenCalled();
    });

    it("requires a payload argument", async () => {
      expect(await rig.run("send", "user.created")).toBe(1);
      expect(rig.err.join("\n")).toContain("requires a <jsonPayload>");
      expect(rig.fake.sendMessage).not.toHaveBeenCalled();
    });

    it("rejects a payload that is not valid JSON", async () => {
      expect(await rig.run("send", "user.created", "{not json")).toBe(1);
      expect(rig.err.join("\n")).toContain("not valid JSON");
      expect(rig.fake.sendMessage).not.toHaveBeenCalled();
    });

    it("parses the JSON payload and prints the send result", async () => {
      expect(await rig.run("send", "user.created", '{"id":1,"ok":true}')).toBe(0);
      expect(rig.fake.sendMessage).toHaveBeenCalledWith({
        eventType: "user.created",
        payload: { id: 1, ok: true },
      });
      const result = rig.json() as { message: { id: string; eventType: string } };
      expect(result.message.id).toBe("msg_1");
      expect(result.message.eventType).toBe("user.created");
    });
  });

  describe("list-endpoints", () => {
    it("prints the endpoint array as JSON", async () => {
      expect(await rig.run("list-endpoints")).toBe(0);
      const eps = rig.json() as Array<{ id: string }>;
      expect(eps.map((e) => e.id)).toEqual(["ep_1", "ep_2"]);
    });
  });

  describe("create-endpoint", () => {
    it("requires a url", async () => {
      expect(await rig.run("create-endpoint")).toBe(1);
      expect(rig.err.join("\n")).toContain("requires a <url>");
      expect(rig.fake.createEndpoint).not.toHaveBeenCalled();
    });

    it("subscribes to all events when no event types are given (omits the key)", async () => {
      expect(await rig.run("create-endpoint", "https://x.example/hook")).toBe(0);
      // No `eventTypes` key at all → the gateway treats it as "all events".
      expect(rig.fake.createEndpoint).toHaveBeenCalledWith({ url: "https://x.example/hook" });
      const created = rig.json() as { secret: string };
      expect(created.secret).toBe("whsec_minted_once"); // the once-shown signing secret
    });

    it("passes trailing args as the event-type subscription", async () => {
      expect(
        await rig.run("create-endpoint", "https://x.example/hook", "user.created", "user.deleted"),
      ).toBe(0);
      expect(rig.fake.createEndpoint).toHaveBeenCalledWith({
        url: "https://x.example/hook",
        eventTypes: ["user.created", "user.deleted"],
      });
    });
  });

  describe("single-id read verbs (get-endpoint / get-message / test-endpoint)", () => {
    it("get-endpoint requires an id", async () => {
      expect(await rig.run("get-endpoint")).toBe(1);
      expect(rig.err.join("\n")).toContain("requires an <endpointId>");
      expect(rig.fake.getEndpoint).not.toHaveBeenCalled();
    });

    it("get-endpoint fetches and prints one endpoint", async () => {
      expect(await rig.run("get-endpoint", "ep_1")).toBe(0);
      expect(rig.fake.getEndpoint).toHaveBeenCalledWith("ep_1");
      expect((rig.json() as { id: string }).id).toBe("ep_1");
    });

    it("get-message fetches and prints one message", async () => {
      expect(await rig.run("get-message", "msg_9")).toBe(0);
      expect(rig.fake.getMessage).toHaveBeenCalledWith("msg_9");
      expect((rig.json() as { id: string }).id).toBe("msg_9");
    });

    it("test-endpoint runs a synchronous test and prints the result", async () => {
      expect(await rig.run("test-endpoint", "ep_1")).toBe(0);
      expect(rig.fake.testEndpoint).toHaveBeenCalledWith("ep_1");
      expect((rig.json() as { delivered: boolean }).delivered).toBe(true);
    });
  });

  describe("delete-endpoint", () => {
    it("requires an id", async () => {
      expect(await rig.run("delete-endpoint")).toBe(1);
      expect(rig.err.join("\n")).toContain("requires an <endpointId>");
      expect(rig.fake.deleteEndpoint).not.toHaveBeenCalled();
    });

    it("deletes and prints a confirmation, not JSON", async () => {
      expect(await rig.run("delete-endpoint", "ep_1")).toBe(0);
      expect(rig.fake.deleteEndpoint).toHaveBeenCalledWith("ep_1");
      expect(rig.out.join("\n")).toBe("Deleted endpoint ep_1");
    });
  });

  describe("list verbs and usage", () => {
    it("list-messages prints the page as JSON", async () => {
      expect(await rig.run("list-messages")).toBe(0);
      expect((rig.json() as { data: unknown[] }).data).toHaveLength(1);
    });

    it("list-event-types prints the catalog as JSON", async () => {
      expect(await rig.run("list-event-types")).toBe(0);
      expect((rig.json() as { data: Array<{ name: string }> }).data[0]?.name).toBe("user.created");
    });

    it("usage prints the tenant usage as JSON", async () => {
      expect(await rig.run("usage")).toBe(0);
      expect(rig.json()).toEqual({ used: 5, quota: 1000, periodStart: 0 });
    });
  });

  describe("configuration errors", () => {
    it("reports a missing-config failure on stderr and exits 1 for a gateway verb", async () => {
      expect(await rig.runUnconfigured("list-endpoints")).toBe(1);
      expect(rig.err.join("\n")).toContain("POSTHORN_URL is not set");
      expect(rig.builds()).toBe(1); // building was attempted (and failed) for a real verb
    });
  });

  describe("SDK error mapping", () => {
    it("renders a PosthornApiError as `API error <status> (<code>)`", async () => {
      rig.fake.getEndpoint.mockRejectedValueOnce(
        new PosthornApiError(404, "not_found", "no endpoint with that id"),
      );
      expect(await rig.run("get-endpoint", "ep_missing")).toBe(1);
      expect(rig.err.join("\n")).toContain("API error 404 (not_found): no endpoint with that id");
    });

    it("renders a PosthornTimeoutError distinctly", async () => {
      rig.fake.listEndpoints.mockRejectedValueOnce(new PosthornTimeoutError("deadline exceeded"));
      expect(await rig.run("list-endpoints")).toBe(1);
      expect(rig.err.join("\n")).toContain("request timed out: deadline exceeded");
    });

    it("renders a transport-level PosthornError", async () => {
      rig.fake.health.mockRejectedValueOnce(new PosthornError("connection refused"));
      expect(await rig.run("health")).toBe(1);
      expect(rig.err.join("\n")).toContain("request failed: connection refused");
    });

    it("renders an unexpected non-Posthorn error without leaking a stack", async () => {
      rig.fake.getUsage.mockRejectedValueOnce(new Error("kaboom"));
      expect(await rig.run("usage")).toBe(1);
      expect(rig.err.join("\n")).toContain("unexpected error: kaboom");
    });
  });
});
