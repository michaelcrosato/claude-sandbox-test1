/**
 * The `posthorn client` command surface — the **tenant-facing CLI**, a thin
 * shell over the {@link PosthornClient} SDK for producers who want to send events
 * and manage their endpoints without writing code or hand-rolling `curl`.
 *
 * It is the mirror image of `posthorn admin` ({@link import("./admin.js").runAdminCommand}):
 *
 * - `admin` is the **operator** path — it opens the *local data store* on the host
 *   that owns the data directory and provisions tenants/keys behind the
 *   filesystem privilege boundary (there is deliberately no HTTP route for it).
 * - `client` is the **consumer** path — it is an ordinary API caller. It holds no
 *   special privilege, talks to a (possibly remote) gateway over HTTP with a normal
 *   API key, and can do nothing the SDK could not.
 *
 * Following the same pure-core / thin-I/O discipline, {@link runClientCommand} is the
 * tested core: it takes a `makeClient` factory and output sinks, performs no I/O of
 * its own, and returns a process exit code. `main.ts` is the thin shell that reads
 * `POSTHORN_URL` + `POSTHORN_API_KEY` from the environment to build the factory. The
 * factory is invoked **lazily** — `posthorn client help` and an unknown command never
 * touch it, so usage works with no configuration at all — and any SDK error
 * ({@link PosthornApiError}, {@link PosthornTimeoutError}) is caught and rendered as a
 * clean stderr line + exit 1 rather than an unhandled rejection.
 */

import {
  PosthornApiError,
  PosthornError,
  PosthornTimeoutError,
} from "../sdk/client.js";
import type { CreateEndpointInput, PosthornClient } from "../sdk/client.js";

/** Sinks and the client factory a {@link runClientCommand} invocation works through. */
export interface ClientCliDeps {
  /**
   * Build the SDK client. Called **only** by verbs that hit the gateway —
   * help/usage and unknown commands never call it, so `posthorn client help` works
   * with no `POSTHORN_URL`/`POSTHORN_API_KEY` configured. May throw with a
   * user-facing message when required configuration is absent; that message is
   * routed to {@link ClientCliDeps.err} and the command exits 1.
   */
  readonly makeClient: () => PosthornClient;
  /** Normal output sink (stdout in production; a capture buffer in tests). */
  readonly out: (line: string) => void;
  /** Error/diagnostic sink (stderr in production; a capture buffer in tests). */
  readonly err: (line: string) => void;
}

/** Exit code: success. */
const EXIT_OK = 0;
/** Exit code: a usage error or a failed operation (bad args, missing config, API error). */
const EXIT_ERR = 1;

/** The full `posthorn client` usage text. */
export const CLIENT_USAGE = `posthorn client — send events and manage your endpoints over the HTTP API

Usage:
  posthorn client health                                Liveness probe (GET /healthz)
  posthorn client send <eventType> <jsonPayload>        Publish an event; prints the message + fan-out summary
  posthorn client list-endpoints                        List your endpoints
  posthorn client create-endpoint <url> [eventType...]  Create an endpoint (no types = all events); prints the signing secret ONCE
  posthorn client get-endpoint <endpointId>             Show one endpoint
  posthorn client delete-endpoint <endpointId>          Delete an endpoint
  posthorn client test-endpoint <endpointId>            Send a synchronous test delivery (not stored, not billed)
  posthorn client list-messages                         List your recent messages (newest first)
  posthorn client get-message <messageId>               Show a message and its per-endpoint delivery state
  posthorn client list-event-types                      List your event-type catalog
  posthorn client usage                                 Show usage for the current billing period
  posthorn client help                                  Show this help

Configuration (environment):
  POSTHORN_URL       Gateway base URL, e.g. http://127.0.0.1:8080   (required)
  POSTHORN_API_KEY   An API key from \`posthorn admin create-key\`     (required)

Read commands print JSON to stdout (pipe to a tool like jq); commands that mutate print a one-line confirmation.`;

/**
 * Execute one `posthorn client` command.
 *
 * @param args  the command and its arguments, i.e. `process.argv.slice(3)`
 *              (everything after `posthorn client`).
 * @returns the process exit code: `0` on success, `1` on a usage error, missing
 *          configuration, or a failed API call. Never throws for an expected
 *          failure (a 4xx from the gateway, a timeout, a bad argument) — those are
 *          reported through {@link ClientCliDeps.err} and reflected in the exit code.
 */
export async function runClientCommand(
  args: readonly string[],
  deps: ClientCliDeps,
): Promise<number> {
  const { out, err } = deps;
  const [command] = args;

  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      out(CLIENT_USAGE);
      // No command is a usage prompt (exit 1, like most CLIs); explicit help is success.
      return command === undefined ? EXIT_ERR : EXIT_OK;

    case "health":
    case "send":
    case "list-endpoints":
    case "create-endpoint":
    case "get-endpoint":
    case "delete-endpoint":
    case "test-endpoint":
    case "list-messages":
    case "get-message":
    case "list-event-types":
    case "usage":
      // A gateway-touching verb: build the client lazily here so the cases above
      // need no configuration, then run inside a single SDK-error → stderr boundary.
      return runApiCommand(command, args.slice(1), deps);

    default:
      err(`unknown command "${command}"`);
      err(CLIENT_USAGE);
      return EXIT_ERR;
  }
}

/**
 * Build the client (reporting a missing-config failure cleanly) and dispatch one
 * gateway-touching verb, translating any SDK error into a stderr line + exit 1.
 */
async function runApiCommand(
  command: string,
  rest: readonly string[],
  deps: ClientCliDeps,
): Promise<number> {
  const { out, err } = deps;

  let client: PosthornClient;
  try {
    client = deps.makeClient();
  } catch (e) {
    // Missing/blank POSTHORN_URL or POSTHORN_API_KEY (or an otherwise-unbuildable
    // client) — surface the factory's own message; it tells the user what to set.
    err(messageOf(e));
    return EXIT_ERR;
  }

  try {
    switch (command) {
      case "health":
        return printJson(await client.health(), out);

      case "send":
        // `return await` (not bare `return`) so a rejection from the delegated
        // helper is caught by this function's try/catch, not leaked to the caller.
        return await sendMessage(rest, client, out, err);

      case "list-endpoints":
        return printJson(await client.listEndpoints(), out);

      case "create-endpoint":
        return await createEndpoint(rest, client, out, err);

      case "get-endpoint":
        return await withId(rest, "get-endpoint", "<endpointId>", (id) => client.getEndpoint(id), out, err);

      case "delete-endpoint":
        return await deleteEndpoint(rest, client, out, err);

      case "test-endpoint":
        return await withId(rest, "test-endpoint", "<endpointId>", (id) => client.testEndpoint(id), out, err);

      case "get-message":
        return await withId(rest, "get-message", "<messageId>", (id) => client.getMessage(id), out, err);

      case "list-messages":
        return printJson(await client.listMessages(), out);

      case "list-event-types":
        return printJson(await client.listEventTypes(), out);

      case "usage":
        return printJson(await client.getUsage(), out);

      /* c8 ignore next 2 -- unreachable: the caller's switch gates the verb set. */
      default:
        return EXIT_ERR;
    }
  } catch (e) {
    return reportSdkError(e, err);
  }
}

/** Send an event — `send <eventType> <jsonPayload>`. The payload arg is parsed as JSON. */
async function sendMessage(
  rest: readonly string[],
  client: PosthornClient,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const eventType = rest[0];
  if (eventType === undefined || eventType === "") {
    err("send requires an <eventType> and a <jsonPayload>");
    err("usage: posthorn client send <eventType> <jsonPayload>");
    return EXIT_ERR;
  }
  const payloadRaw = rest[1];
  if (payloadRaw === undefined) {
    err("send requires a <jsonPayload> argument (a JSON value, e.g. '{\"id\":1}')");
    err("usage: posthorn client send <eventType> <jsonPayload>");
    return EXIT_ERR;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    err(`<jsonPayload> is not valid JSON: ${payloadRaw}`);
    return EXIT_ERR;
  }
  return printJson(await client.sendMessage({ eventType, payload }), out);
}

/** Create an endpoint — `create-endpoint <url> [eventType...]`. No types subscribes to all events. */
async function createEndpoint(
  rest: readonly string[],
  client: PosthornClient,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const url = rest[0];
  if (url === undefined || url === "") {
    err("create-endpoint requires a <url>");
    err("usage: posthorn client create-endpoint <url> [eventType...]");
    return EXIT_ERR;
  }
  const eventTypes = rest.slice(1);
  const input: CreateEndpointInput = {
    url,
    // Omit entirely (→ subscribe to all events) when no types were given; a present
    // key is required by exactOptionalPropertyTypes only when we actually have a value.
    ...(eventTypes.length > 0 ? { eventTypes } : {}),
  };
  return printJson(await client.createEndpoint(input), out);
}

/** Delete an endpoint — `delete-endpoint <endpointId>`. Prints a confirmation, not JSON. */
async function deleteEndpoint(
  rest: readonly string[],
  client: PosthornClient,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const id = rest[0];
  if (id === undefined || id === "") {
    err("delete-endpoint requires an <endpointId>");
    err("usage: posthorn client delete-endpoint <endpointId>");
    return EXIT_ERR;
  }
  await client.deleteEndpoint(id);
  out(`Deleted endpoint ${id}`);
  return EXIT_OK;
}

/**
 * Shared shape for the single-`<id>` read verbs (get-endpoint / get-message /
 * test-endpoint): validate the id, run the SDK call, print its JSON result.
 */
async function withId(
  rest: readonly string[],
  verb: string,
  argName: string,
  run: (id: string) => Promise<unknown>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const id = rest[0];
  if (id === undefined || id === "") {
    err(`${verb} requires an ${argName}`);
    err(`usage: posthorn client ${verb} ${argName}`);
    return EXIT_ERR;
  }
  return printJson(await run(id), out);
}

/** Print a value as pretty JSON to the output sink and report success. */
function printJson(value: unknown, out: (line: string) => void): number {
  out(JSON.stringify(value, null, 2));
  return EXIT_OK;
}

/** Render an SDK error as a single human-readable stderr line and report failure. */
function reportSdkError(e: unknown, err: (line: string) => void): number {
  if (e instanceof PosthornApiError) {
    err(`API error ${e.status} (${e.code}): ${e.message}`);
  } else if (e instanceof PosthornTimeoutError) {
    err(`request timed out: ${e.message}`);
  } else if (e instanceof PosthornError) {
    err(`request failed: ${e.message}`);
  } else {
    err(`unexpected error: ${messageOf(e)}`);
  }
  return EXIT_ERR;
}

/** Best-effort message extraction for a caught unknown. */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
