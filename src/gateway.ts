import type { PosthornConfig } from './config';

export interface GatewayConfig extends Partial<PosthornConfig> {
  readonly serviceName?: string;
}

export interface Gateway {
  readonly serviceName: string;
  readonly config: Readonly<GatewayConfig>;
}

export function createGateway(config: GatewayConfig = {}): Gateway {
  const normalizedConfig: GatewayConfig = Object.freeze({
    ...config,
    serviceName: config.serviceName ?? 'posthorn',
  });

  return Object.freeze({
    serviceName: normalizedConfig.serviceName ?? 'posthorn',
    config: normalizedConfig,
  });
}
