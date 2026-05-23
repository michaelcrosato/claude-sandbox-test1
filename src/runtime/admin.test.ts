import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAppStore } from "../apps/in-memory-app-store.js";
import { ADMIN_USAGE, runAdminCommand, type AdminDeps } from "./admin.js";

/**
 * A test rig: a deterministic in-memory store (fixed clock + sequential id/secret
 * generators so output is byte-stable) plus output/error capture buffers. The
 * generators mirror how the rest of the suite injects determinism into the stores.
 */
function makeRig(): {
  store: InMemoryAppStore;
  out: string[];
  err: string[];
  deps: AdminDeps;
  run: (...args: string[]) => Promise<number>;
} {
  let appSeq = 0;
  let keySeq = 0;
  let secretSeq = 0;
  const store = new InMemoryAppStore({
    now: () => 1_700_000_000_000, // fixed → ISO 2023-11-14T22:13:20.000Z
    generateAppId: () => `app_${++appSeq}`,
    generateApiKeyId: () => `ak_${++keySeq}`,
    // Realistically long (> the 12-char display prefix) so the prefix is a strict
    // truncation — a short secret would make prefix == secret and mask leak checks.
    generateApiKeySecret: () => `phk_live_secret_value_${++secretSeq}`,
  });
  const out: string[] = [];
  const err: string[] = [];
  const deps: AdminDeps = {
    store,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return {
    store,
    out,
    err,
    deps,
    run: (...args: string[]) => runAdminCommand(args, deps),
  };
}

describe("runAdminCommand", () => {
  let rig: ReturnType<typeof makeRig>;
  beforeEach(() => {
    rig = makeRig();
  });

  describe("help / usage", () => {
    it("prints usage and exits 0 for an explicit `help`", async () => {
      expect(await rig.run("help")).toBe(0);
      expect(rig.out.join("\n")).toBe(ADMIN_USAGE);
      expect(rig.err).toEqual([]);
    });

    it("treats -h and --help the same as help", async () => {
      expect(await rig.run("-h")).toBe(0);
      expect(await rig.run("--help")).toBe(0);
    });

    it("prints usage but exits 1 when no command is given (a prompt, not success)", async () => {
      expect(await rig.run()).toBe(1);
      expect(rig.out.join("\n")).toBe(ADMIN_USAGE);
    });

    it("rejects an unknown command with exit 1 and shows usage on stderr", async () => {
      expect(await rig.run("frobnicate")).toBe(1);
      expect(rig.err.join("\n")).toContain('unknown command "frobnicate"');
      expect(rig.err.join("\n")).toContain("Usage:");
    });
  });

  describe("create-app", () => {
    it("creates an unnamed app and prints its id + a next-step hint", async () => {
      expect(await rig.run("create-app")).toBe(0);
      expect(rig.store.size).toBe(1);
      expect(rig.out).toEqual([
        "Created app app_1",
        "  name: (none)",
        "Next: mint a key with  posthorn admin create-key app_1",
      ]);
    });

    it("uses a provided name", async () => {
      expect(await rig.run("create-app", "Acme")).toBe(0);
      const [app] = await rig.store.list();
      expect(app?.name).toBe("Acme");
      expect(rig.out).toContain("  name: Acme");
    });

    it("rejoins an unquoted multi-word name", async () => {
      await rig.run("create-app", "Acme", "Corp");
      const [app] = await rig.store.list();
      expect(app?.name).toBe("Acme Corp");
    });
  });

  describe("create-key", () => {
    it("requires an appId", async () => {
      expect(await rig.run("create-key")).toBe(1);
      expect(rig.err.join("\n")).toContain("requires an <appId>");
    });

    it("fails for an unknown app without throwing", async () => {
      expect(await rig.run("create-key", "app_missing")).toBe(1);
      expect(rig.err.join("\n")).toContain('no app with id "app_missing"');
    });

    it("mints a key and prints the secret exactly once with a one-time warning", async () => {
      await rig.run("create-app");
      const code = await rig.run("create-key", "app_1");
      expect(code).toBe(0);
      const joined = rig.out.join("\n");
      expect(joined).toContain("Created API key ak_1 for app app_1");
      expect(joined).toContain("secret: phk_live_secret_value_1");
      expect(joined).toContain("shown ONCE");
      expect(joined).toContain("Authorization: Bearer");
      // The plaintext secret must appear exactly once in the output.
      const occurrences = joined.split("phk_live_secret_value_1").length - 1;
      expect(occurrences).toBe(1);
    });

    it("prints the non-secret display prefix, not the full secret, as the prefix", async () => {
      await rig.run("create-app");
      await rig.run("create-key", "app_1");
      // `prefix:` line carries only the 12-char display prefix, not the full secret.
      const prefixLine = rig.out.find((l) => l.includes("prefix:"));
      expect(prefixLine).toContain("phk_live_secret_value_1".slice(0, 12));
      expect(prefixLine).not.toContain("phk_live_secret_value_1");
    });
  });

  describe("list-apps", () => {
    it("reports emptiness with a creation hint", async () => {
      expect(await rig.run("list-apps")).toBe(0);
      expect(rig.out.join("\n")).toContain("(no apps");
    });

    it("lists apps oldest-first with id, ISO time, and name", async () => {
      await rig.run("create-app", "First");
      await rig.run("create-app"); // unnamed
      rig.out.length = 0;
      expect(await rig.run("list-apps")).toBe(0);
      expect(rig.out).toEqual([
        "app_1  2023-11-14T22:13:20.000Z  First",
        "app_2  2023-11-14T22:13:20.000Z  (none)",
      ]);
    });
  });

  describe("list-keys", () => {
    it("requires an appId", async () => {
      expect(await rig.run("list-keys")).toBe(1);
      expect(rig.err.join("\n")).toContain("requires an <appId>");
    });

    it("distinguishes an unknown app (error) from an app with no keys (ok)", async () => {
      expect(await rig.run("list-keys", "app_missing")).toBe(1);
      expect(rig.err.join("\n")).toContain('no app with id "app_missing"');

      await rig.run("create-app");
      rig.out.length = 0;
      expect(await rig.run("list-keys", "app_1")).toBe(0);
      expect(rig.out.join("\n")).toContain("(no keys");
    });

    it("lists key metadata with status and never the secret", async () => {
      await rig.run("create-app");
      await rig.run("create-key", "app_1");
      rig.out.length = 0;
      expect(await rig.run("list-keys", "app_1")).toBe(0);
      const joined = rig.out.join("\n");
      expect(joined).toContain("ak_1");
      expect(joined).toContain("live");
      expect(joined).not.toContain("phk_live_secret_value_1"); // full secret never echoed
    });

    it("shows a revoked key's revocation time", async () => {
      await rig.run("create-app");
      await rig.run("create-key", "app_1");
      await rig.run("revoke-key", "ak_1");
      rig.out.length = 0;
      await rig.run("list-keys", "app_1");
      expect(rig.out.join("\n")).toContain("revoked @ 2023-11-14T22:13:20.000Z");
    });
  });

  describe("revoke-key", () => {
    it("requires a keyId", async () => {
      expect(await rig.run("revoke-key")).toBe(1);
      expect(rig.err.join("\n")).toContain("requires a <keyId>");
    });

    it("revokes a live key", async () => {
      await rig.run("create-app");
      await rig.run("create-key", "app_1");
      expect(await rig.run("revoke-key", "ak_1")).toBe(0);
      expect(rig.out.join("\n")).toContain("Revoked key ak_1");
    });

    it("fails (exit 1) for an unknown or already-revoked key", async () => {
      expect(await rig.run("revoke-key", "ak_missing")).toBe(1);

      await rig.run("create-app");
      await rig.run("create-key", "app_1");
      await rig.run("revoke-key", "ak_1");
      rig.err.length = 0;
      expect(await rig.run("revoke-key", "ak_1")).toBe(1); // second revoke is a no-op failure
      expect(rig.err.join("\n")).toContain("already revoked");
    });
  });

  describe("end-to-end: the bootstrap actually works", () => {
    it("a secret minted via the CLI authenticates against the same store", async () => {
      await rig.run("create-app", "Tenant");
      await rig.run("create-key", "app_1");
      // Recover the secret exactly as an operator would: read it off the output.
      const secretLine = rig.out.find((l) => l.includes("secret:"));
      const secret = secretLine?.split("secret:")[1]?.trim();
      expect(secret).toBe("phk_live_secret_value_1");

      const app = await rig.store.authenticate(secret as string);
      expect(app?.id).toBe("app_1");
      expect(app?.name).toBe("Tenant");
    });

    it("a revoked key no longer authenticates", async () => {
      await rig.run("create-app");
      await rig.run("create-key", "app_1");
      expect(await rig.store.authenticate("phk_live_secret_value_1")).not.toBeNull();
      await rig.run("revoke-key", "ak_1");
      expect(await rig.store.authenticate("phk_live_secret_value_1")).toBeNull();
    });
  });
});
