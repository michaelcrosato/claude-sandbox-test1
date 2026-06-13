#!/usr/bin/env node
import { PosthornAdminClient, PosthornApiError, PosthornClient, type ClientRouteMapping } from './client';
import type { JsonValue } from './messages';

export interface CliStreams {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export interface CliOptions {
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly streams?: CliStreams;
}

export const POSTHORN_CLI_ROUTES: readonly ClientRouteMapping[] = Object.freeze([
  cliRoute('create-endpoint', 'post', '/v1/endpoints'),
  cliRoute('send', 'post', '/v1/messages'),
  cliRoute('list-endpoints', 'get', '/v1/endpoints'),
  cliRoute('get-message', 'get', '/v1/messages/{id}'),
  cliRoute('usage', 'get', '/v1/usage'),
]);

export const POSTHORN_ADMIN_CLI_ROUTES: readonly ClientRouteMapping[] = Object.freeze([
  cliRoute('create-app', 'post', '/v1/admin/apps'),
  cliRoute('list-apps', 'get', '/v1/admin/apps'),
  cliRoute('get-app', 'get', '/v1/admin/apps/{id}'),
  cliRoute('update-app', 'patch', '/v1/admin/apps/{id}'),
  cliRoute('delete-app', 'delete', '/v1/admin/apps/{id}'),
  cliRoute('usage', 'get', '/v1/admin/apps/{id}/usage'),
  cliRoute('rotate-system-secret', 'post', '/v1/admin/apps/{id}/rotate-system-secret'),
  cliRoute('create-key', 'post', '/v1/admin/apps/{id}/keys'),
  cliRoute('list-keys', 'get', '/v1/admin/apps/{id}/keys'),
  cliRoute('revoke-key', 'delete', '/v1/admin/keys/{id}'),
]);

const CLIENT_HELP = `Usage:
  posthorn client create-endpoint <url> [eventType...]
  posthorn client send <eventType> <jsonPayload> [--idempotency-key <key>]
  posthorn client list-endpoints
  posthorn client get-message <messageId>
  posthorn client usage
  posthorn client help

Environment:
  POSTHORN_URL       Gateway base URL
  POSTHORN_API_KEY   Tenant API key
`;

const ADMIN_HELP = `Usage:
  posthorn admin create-app <name> [--monthly-message-quota <integer|null>]
  posthorn admin list-apps
  posthorn admin get-app <appId>
  posthorn admin update-app <appId> [--name <name>] [--monthly-message-quota <integer|null>]
  posthorn admin delete-app <appId>
  posthorn admin create-key <appId> [name]
  posthorn admin list-keys <appId>
  posthorn admin revoke-key <apiKeyId>
  posthorn admin usage <appId>
  posthorn admin rotate-system-secret <appId> [--overlap-seconds <integer>]
  posthorn admin help

Environment:
  POSTHORN_URL           Gateway base URL
  POSTHORN_ADMIN_TOKEN   Admin bearer token
`;

export async function runPosthornCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: CliOptions = {},
): Promise<number> {
  const streams = options.streams ?? { stdout: process.stdout, stderr: process.stderr };

  try {
    if (argv[0] === 'admin') {
      return await runAdminCommand(argv.slice(1), env, options.fetch, streams);
    }

    return await runClientCommand(stripClientNamespace(argv), env, options.fetch, streams);
  } catch (error) {
    writeCliError(streams.stderr, error);
    return 1;
  }
}

function cliRoute(command: string, method: ClientRouteMapping['method'], path: string): ClientRouteMapping {
  return Object.freeze({ methodName: command, method, path });
}

function stripClientNamespace(argv: readonly string[]): readonly string[] {
  return argv[0] === 'client' ? argv.slice(1) : argv;
}

async function runClientCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: CliOptions['fetch'],
  streams: CliStreams,
): Promise<number> {
  const command = args[0] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    streams.stdout.write(CLIENT_HELP);
    return 0;
  }

  const client = createClient(env, fetchImpl);
  switch (command) {
    case 'create-endpoint':
      writeJson(streams.stdout, await client.createEndpoint(parseCreateEndpointArgs(args.slice(1))));
      return 0;
    case 'send':
      writeJson(streams.stdout, await client.sendMessage(parseSendArgs(args.slice(1))));
      return 0;
    case 'list-endpoints':
      expectNoArgs(command, args.slice(1));
      writeJson(streams.stdout, (await client.listEndpoints()).data);
      return 0;
    case 'get-message':
      writeJson(streams.stdout, await client.getMessage(singleArg(command, args.slice(1), 'messageId')));
      return 0;
    case 'usage':
      expectNoArgs(command, args.slice(1));
      writeJson(streams.stdout, (await client.getUsage()).usage);
      return 0;
    default:
      throw new CliUsageError(`Unknown command: ${command}. Run "posthorn client help".`);
  }
}

async function runAdminCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: CliOptions['fetch'],
  streams: CliStreams,
): Promise<number> {
  const command = args[0] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    streams.stdout.write(ADMIN_HELP);
    return 0;
  }

  const admin = createAdminClient(env, fetchImpl);
  switch (command) {
    case 'create-app':
      writeJson(streams.stdout, await admin.createApp(parseCreateAppArgs(args.slice(1))));
      return 0;
    case 'list-apps':
      expectNoArgs(command, args.slice(1));
      writeJson(streams.stdout, (await admin.listApps()).data);
      return 0;
    case 'get-app':
      writeJson(streams.stdout, await admin.getApp(singleArg(command, args.slice(1), 'appId')));
      return 0;
    case 'update-app': {
      const parsed = parseUpdateAppArgs(args.slice(1));
      writeJson(streams.stdout, await admin.updateApp(parsed.appId, parsed.input));
      return 0;
    }
    case 'delete-app':
      await admin.deleteApp(singleArg(command, args.slice(1), 'appId'));
      writeJson(streams.stdout, { deleted: true });
      return 0;
    case 'create-key': {
      const parsed = parseCreateKeyArgs(args.slice(1));
      writeJson(streams.stdout, await admin.createApiKey(parsed.appId, parsed.input));
      return 0;
    }
    case 'list-keys':
      writeJson(streams.stdout, (await admin.listApiKeys(singleArg(command, args.slice(1), 'appId'))).data);
      return 0;
    case 'revoke-key':
      await admin.revokeApiKey(singleArg(command, args.slice(1), 'apiKeyId'));
      writeJson(streams.stdout, { revoked: true });
      return 0;
    case 'usage':
      writeJson(streams.stdout, (await admin.getAppUsage(singleArg(command, args.slice(1), 'appId'))).usage);
      return 0;
    case 'rotate-system-secret': {
      const parsed = parseRotateSystemSecretArgs(args.slice(1));
      writeJson(streams.stdout, await admin.rotateAppSystemSecret(parsed.appId, parsed.input));
      return 0;
    }
    default:
      throw new CliUsageError(`Unknown admin command: ${command}. Run "posthorn admin help".`);
  }
}

function createClient(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: CliOptions['fetch'],
): PosthornClient {
  const baseUrl = env.POSTHORN_URL;
  const apiKey = env.POSTHORN_API_KEY;
  if (baseUrl === undefined || baseUrl.trim() === '' || apiKey === undefined || apiKey.trim() === '') {
    throw new CliUsageError('Missing POSTHORN_URL or POSTHORN_API_KEY.');
  }

  return new PosthornClient({ baseUrl, apiKey, fetch: fetchImpl });
}

function createAdminClient(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: CliOptions['fetch'],
): PosthornAdminClient {
  const baseUrl = env.POSTHORN_URL;
  const adminToken = env.POSTHORN_ADMIN_TOKEN;
  if (baseUrl === undefined || baseUrl.trim() === '' || adminToken === undefined || adminToken.trim() === '') {
    throw new CliUsageError('Missing POSTHORN_URL or POSTHORN_ADMIN_TOKEN.');
  }

  return new PosthornAdminClient({ baseUrl, adminToken, fetch: fetchImpl });
}

function parseCreateEndpointArgs(args: readonly string[]): { readonly url: string; readonly eventTypes?: readonly string[] } {
  const [url, ...eventTypes] = args;
  if (url === undefined || url.trim() === '') {
    throw new CliUsageError('create-endpoint requires a URL.');
  }

  return {
    url,
    ...(eventTypes.length === 0 ? {} : { eventTypes }),
  };
}

function parseCreateAppArgs(args: readonly string[]): {
  readonly name: string;
  readonly monthlyMessageQuota?: number | null;
} {
  const name = args[0];
  if (name === undefined || name.trim() === '') {
    throw new CliUsageError('create-app requires a name.');
  }

  const input: { name: string; monthlyMessageQuota?: number | null } = { name };
  parseAdminAppOptions('create-app', args.slice(1), input, false);
  return input;
}

function parseUpdateAppArgs(args: readonly string[]): {
  readonly appId: string;
  readonly input: { readonly name?: string; readonly monthlyMessageQuota?: number | null };
} {
  const appId = args[0];
  if (appId === undefined || appId.trim() === '') {
    throw new CliUsageError('update-app requires appId.');
  }

  const input: { name?: string; monthlyMessageQuota?: number | null } = {};
  parseAdminAppOptions('update-app', args.slice(1), input, true);
  if (!Object.hasOwn(input, 'name') && !Object.hasOwn(input, 'monthlyMessageQuota')) {
    throw new CliUsageError('update-app requires --name or --monthly-message-quota.');
  }

  return { appId, input };
}

function parseAdminAppOptions(
  command: string,
  args: readonly string[],
  input: { name?: string; monthlyMessageQuota?: number | null },
  allowName: boolean,
): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--name' && allowName) {
      input.name = optionValue(command, arg, args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--monthly-message-quota') {
      input.monthlyMessageQuota = parseNullableSafeInteger(optionValue(command, arg, args[index + 1]), arg);
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown option for ${command}: ${arg ?? ''}.`);
  }
}

function parseCreateKeyArgs(args: readonly string[]): {
  readonly appId: string;
  readonly input: { readonly name?: string };
} {
  const appId = args[0];
  if (appId === undefined || appId.trim() === '') {
    throw new CliUsageError('create-key requires appId.');
  }
  if (args.length > 2) {
    throw new CliUsageError('create-key accepts at most one name.');
  }

  return {
    appId,
    input: args[1] === undefined ? {} : { name: args[1] },
  };
}

function parseRotateSystemSecretArgs(args: readonly string[]): {
  readonly appId: string;
  readonly input: { readonly overlapSeconds?: number };
} {
  const appId = args[0];
  if (appId === undefined || appId.trim() === '') {
    throw new CliUsageError('rotate-system-secret requires appId.');
  }

  const input: { overlapSeconds?: number } = {};
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--overlap-seconds') {
      input.overlapSeconds = parseSafeInteger(optionValue('rotate-system-secret', arg, args[index + 1]), arg);
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown option for rotate-system-secret: ${arg ?? ''}.`);
  }

  return { appId, input };
}

function parseSendArgs(args: readonly string[]): {
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly idempotencyKey?: string;
} {
  const operands: string[] = [];
  let idempotencyKey: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--idempotency-key') {
      const value = args[index + 1];
      if (value === undefined || value.trim() === '') {
        throw new CliUsageError('--idempotency-key requires a value.');
      }
      idempotencyKey = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--') === true) {
      throw new CliUsageError(`Unknown option: ${arg}.`);
    }
    if (arg !== undefined) operands.push(arg);
  }

  if (operands.length !== 2) {
    throw new CliUsageError('send requires an event type and JSON payload.');
  }

  return {
    eventType: operands[0],
    payload: parseJsonPayload(operands[1]),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function parseJsonPayload(input: string): JsonValue {
  try {
    return JSON.parse(input) as JsonValue;
  } catch {
    throw new CliUsageError('Payload must be valid JSON.');
  }
}

function parseNullableSafeInteger(input: string, optionName: string): number | null {
  if (input === 'null') return null;
  return parseSafeInteger(input, optionName);
}

function parseSafeInteger(input: string, optionName: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 0) {
    const suffix = optionName === '--monthly-message-quota' ? ' or null' : '';
    throw new CliUsageError(`${optionName} requires a non-negative safe integer${suffix}.`);
  }

  return value;
}

function optionValue(command: string, optionName: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new CliUsageError(`${command} ${optionName} requires a value.`);
  }

  return value;
}

function singleArg(command: string, args: readonly string[], name: string): string {
  if (args.length !== 1 || args[0]?.trim() === '') {
    throw new CliUsageError(`${command} requires ${name}.`);
  }

  return args[0];
}

function expectNoArgs(command: string, args: readonly string[]): void {
  if (args.length > 0) {
    throw new CliUsageError(`${command} does not accept positional arguments.`);
  }
}

function writeJson(stdout: Pick<NodeJS.WriteStream, 'write'>, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeCliError(stderr: Pick<NodeJS.WriteStream, 'write'>, error: unknown): void {
  if (error instanceof PosthornApiError) {
    stderr.write(`API error ${error.status} (${error.code}): ${error.message}\n`);
    return;
  }
  if (error instanceof CliUsageError) {
    stderr.write(`Error: ${error.message}\n`);
    return;
  }

  stderr.write('Error: Unexpected failure.\n');
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

if (require.main === module) {
  void runPosthornCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
