import type { PosthornConfig } from './config';
import { loadConfig } from './config';
import type { Gateway, GatewayAddress } from './gateway';
import { createGateway } from './gateway';
import { openStorage } from './storage';
import type { DeliveryFetch, DeliveryWorker } from './worker';
import { createDeliveryWorker } from './worker';

export interface PosthornServer {
  readonly address: GatewayAddress;
  stop(): Promise<void>;
}

export interface StartPosthornServerOptions {
  readonly fetch?: DeliveryFetch;
  readonly now?: () => Date;
}

export interface ServerStreams {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export interface RunPosthornServerProcessOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly streams?: ServerStreams;
}

export async function startPosthornServer(
  config: PosthornConfig = loadConfig(),
  options: StartPosthornServerOptions = {},
): Promise<PosthornServer> {
  const storage = openStorage({ dataDir: config.dataDir });
  const gateway = createGateway(config, {
    openStorage: () => storage,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const worker = createDeliveryWorker(storage, {
    ...config.worker,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  let workerStarted = false;
  try {
    const address = await gateway.start();
    worker.start();
    workerStarted = true;
    let stopped = false;

    return Object.freeze({
      address,
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          if (workerStarted) {
            await worker.stop();
          }
        } finally {
          await gateway.stop();
        }
      },
    });
  } catch (error) {
    await stopAfterFailedStart(worker, gateway, workerStarted);
    throw error;
  }
}

export async function runPosthornServerProcess(
  options: RunPosthornServerProcessOptions = {},
): Promise<PosthornServer> {
  const streams = options.streams ?? { stdout: process.stdout, stderr: process.stderr };
  const server = await startPosthornServer(loadConfig(options.env ?? process.env));
  streams.stdout.write(`Posthorn listening on ${server.address.url}\n`);

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    void server
      .stop()
      .then(() => {
        streams.stdout.write(`Posthorn stopped after ${signal}.\n`);
      })
      .catch((error: unknown) => {
        process.exitCode = 1;
        streams.stderr.write(`Posthorn failed to stop: ${formatError(error)}\n`);
      });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

async function stopAfterFailedStart(worker: DeliveryWorker, gateway: Gateway, workerStarted: boolean): Promise<void> {
  try {
    if (workerStarted) {
      await worker.stop();
    }
  } finally {
    await gateway.stop();
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  void runPosthornServerProcess().catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`Posthorn failed to start: ${formatError(error)}\n`);
  });
}
