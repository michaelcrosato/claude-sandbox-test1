export interface GatewayConfig {
  readonly serviceName?: string;
}

export interface Gateway {
  readonly serviceName: string;
  readonly config: Readonly<GatewayConfig>;
}

export function createGateway(config: GatewayConfig = {}): Gateway {
  const normalizedConfig: GatewayConfig = {
    serviceName: config.serviceName ?? 'posthorn',
  };

  return Object.freeze({
    serviceName: normalizedConfig.serviceName ?? 'posthorn',
    config: Object.freeze(normalizedConfig),
  });
}
