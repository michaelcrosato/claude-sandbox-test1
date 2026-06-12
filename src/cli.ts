#!/usr/bin/env node
import { PosthornApiError, PosthornClient, type ClientRouteMapping } from './client';
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

const HELP = `Usage:
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

export async function runPosthornCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: CliOptions = {},
): Promise<number> {
  const streams = options.streams ?? { stdout: process.stdout, stderr: process.stderr };
  const args = stripClientNamespace(argv);
  const command = args[0] ?? 'help';

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      streams.stdout.write(HELP);
      return 0;
    }

    const client = createClient(env, options.fetch);
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
