/**
 * The `posthorn admin` command surface — the **bootstrap path** for a deployed
 * gateway.
 *
 * Posthorn's HTTP API authenticates every route with a Bearer API key, but
 * minting that first app + key is a privileged operation with deliberately **no
 * HTTP route** (a caller would need a key to authenticate the call that creates
 * the first key — an open provisioning endpoint is the door we refuse to build;
 * see `gateway.ts`). Until now provisioning was only reachable *programmatically*
 * against {@link AppStore}, which meant a freshly-deployed gateway was
 * unusable out of the box: it boots, but no credential can be created against it
 * without writing TypeScript. This module closes that gap by putting provisioning
 * behind the right privilege boundary — **the filesystem/shell** (you must be able
 * to run the binary on the host that owns the data directory), not the network.
 *
 * Following the codebase's pure-core / thin-I/O discipline, {@link runAdminCommand}
 * is the tested core: it takes an injected {@link AppStore} and output sinks,
 * performs no I/O of its own, and returns a process exit code. `main.ts` is the
 * thin shell that opens the SQLite-backed store at the configured data directory,
 * calls this, and closes the store — so every command's behaviour (including its
 * exit code and exact output) is exhaustively unit-testable without a process,
 * a socket, or the filesystem.
 */

import { UnknownAppError, type AppStore } from "../apps/app.js";

/** Sinks and store a {@link runAdminCommand} invocation writes through. */
export interface AdminDeps {
  /** The store to provision against. The shell opens/closes it; this module only uses it. */
  readonly store: AppStore;
  /** Normal output sink (stdout in production; a capture buffer in tests). */
  readonly out: (line: string) => void;
  /** Error/diagnostic sink (stderr in production; a capture buffer in tests). */
  readonly err: (line: string) => void;
}

/** Exit code: success. */
const EXIT_OK = 0;
/** Exit code: a usage error or a failed operation (unknown app, nothing revoked). */
const EXIT_ERR = 1;

/** Render an epoch-ms timestamp as an ISO-8601 string for human-readable listings. */
function isoTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** The full `posthorn admin` usage text. */
export const ADMIN_USAGE = `posthorn admin — provision tenants and API keys (operates directly on the data store)

Usage:
  posthorn admin create-app [name]    Create a tenant (app); prints its id
  posthorn admin create-key <appId>   Mint an API key for an app; prints the secret ONCE
  posthorn admin list-apps            List all apps (oldest first)
  posthorn admin list-keys <appId>    List an app's API keys (metadata only — never the secret)
  posthorn admin revoke-key <keyId>   Revoke an API key
  posthorn admin backup <dir>         Snapshot the data directory into <dir> (online, consistent)
  posthorn admin restore <dir>        Restore a backup from <dir> (--force to overwrite live data)
  posthorn admin help                 Show this help

The data location follows POSTHORN_DATA_DIR (default ./posthorn-data) — the same store
the server reads. SQLite WAL makes these safe to run against a live gateway.`;

/**
 * Execute one `posthorn admin` command.
 *
 * @param args  the command and its arguments, i.e. `process.argv.slice(3)`
 *              (everything after `posthorn admin`).
 * @returns the process exit code: `0` on success, `1` on a usage error or a
 *          failed operation. Never throws for an expected failure (unknown app,
 *          nothing to revoke) — those are reported through {@link AdminDeps.err}
 *          and reflected in the exit code.
 */
export async function runAdminCommand(
  args: readonly string[],
  deps: AdminDeps,
): Promise<number> {
  const { store, out, err } = deps;
  const [command, ...rest] = args;

  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      out(ADMIN_USAGE);
      // No command is a usage prompt (exit 1, like most CLIs); explicit help is success.
      return command === undefined ? EXIT_ERR : EXIT_OK;

    case "create-app":
      return createApp(rest, store, out);

    case "create-key":
      return createKey(rest, store, out, err);

    case "list-apps":
      return listApps(store, out);

    case "list-keys":
      return listKeys(rest, store, out, err);

    case "revoke-key":
      return revokeKey(rest, store, out, err);

    default:
      err(`unknown command "${command}"`);
      err(ADMIN_USAGE);
      return EXIT_ERR;
  }
}

async function createApp(
  rest: readonly string[],
  store: AppStore,
  out: (line: string) => void,
): Promise<number> {
  // Tolerate an unquoted multi-word name (`create-app Acme Corp`) by rejoining.
  const name = rest.join(" ").trim();
  const app = await store.create(name === "" ? {} : { name });
  out(`Created app ${app.id}`);
  out(`  name: ${app.name === "" ? "(none)" : app.name}`);
  out(`Next: mint a key with  posthorn admin create-key ${app.id}`);
  return EXIT_OK;
}

async function createKey(
  rest: readonly string[],
  store: AppStore,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const appId = rest[0];
  if (appId === undefined || appId === "") {
    err("create-key requires an <appId>");
    err("usage: posthorn admin create-key <appId>");
    return EXIT_ERR;
  }
  let created;
  try {
    created = await store.createApiKey(appId);
  } catch (e) {
    if (e instanceof UnknownAppError) {
      err(`no app with id "${appId}" — create one first with: posthorn admin create-app`);
      return EXIT_ERR;
    }
    throw e;
  }
  out(`Created API key ${created.apiKey.id} for app ${appId}`);
  out(`  prefix: ${created.apiKey.prefix}`);
  out("");
  out(`  secret: ${created.secret}`);
  out("");
  out("This secret is shown ONCE and is not recoverable — store it now.");
  out("Authenticate with header:  Authorization: Bearer <secret>");
  return EXIT_OK;
}

async function listApps(store: AppStore, out: (line: string) => void): Promise<number> {
  const apps = await store.list();
  if (apps.length === 0) {
    out("(no apps — create one with: posthorn admin create-app)");
    return EXIT_OK;
  }
  for (const app of apps) {
    out(`${app.id}  ${isoTime(app.createdAt)}  ${app.name === "" ? "(none)" : app.name}`);
  }
  return EXIT_OK;
}

async function listKeys(
  rest: readonly string[],
  store: AppStore,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const appId = rest[0];
  if (appId === undefined || appId === "") {
    err("list-keys requires an <appId>");
    err("usage: posthorn admin list-keys <appId>");
    return EXIT_ERR;
  }
  // Distinguish "app does not exist" from "app exists but has no keys".
  if ((await store.get(appId)) === null) {
    err(`no app with id "${appId}"`);
    return EXIT_ERR;
  }
  const keys = await store.listApiKeys(appId);
  if (keys.length === 0) {
    out("(no keys — mint one with: posthorn admin create-key " + appId + ")");
    return EXIT_OK;
  }
  for (const key of keys) {
    const status = key.revokedAt === null ? "live" : `revoked @ ${isoTime(key.revokedAt)}`;
    out(`${key.id}  ${key.prefix}  ${isoTime(key.createdAt)}  ${status}`);
  }
  return EXIT_OK;
}

async function revokeKey(
  rest: readonly string[],
  store: AppStore,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const keyId = rest[0];
  if (keyId === undefined || keyId === "") {
    err("revoke-key requires a <keyId>");
    err("usage: posthorn admin revoke-key <keyId>");
    return EXIT_ERR;
  }
  const revoked = await store.revokeApiKey(keyId);
  if (!revoked) {
    err(`no live key with id "${keyId}" (unknown or already revoked)`);
    return EXIT_ERR;
  }
  out(`Revoked key ${keyId}`);
  return EXIT_OK;
}
