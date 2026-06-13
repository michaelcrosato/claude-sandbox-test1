import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Docker deployment artifacts', () => {
  it('builds and runs the compiled gateway without runtime TypeScript tooling', () => {
    const dockerfile = read('Dockerfile');

    expect(dockerfile).toContain('FROM node:24-bookworm-slim AS build');
    expect(dockerfile).toContain('RUN npm ci --ignore-scripts');
    expect(dockerfile).toContain('RUN npm run build');
    expect(dockerfile).toContain('FROM node:24-bookworm-slim AS runtime');
    expect(dockerfile).toContain('POSTHORN_DATA_DIR=/data');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toContain('EXPOSE 3000');
    expect(dockerfile).toContain('/healthz');
    expect(dockerfile).toContain('CMD ["node", "dist/src/server.js"]');
    expect(dockerfile).not.toContain('POSTHORN_ADMIN_TOKEN=');
    expect(dockerfile).not.toContain('ts-node');
  });

  it('keeps secret-shaped files out of the Docker build context', () => {
    const dockerignore = read('.dockerignore');

    expect(dockerignore).toContain('.env');
    expect(dockerignore).toContain('.env.*');
    expect(dockerignore).toContain('*.pem');
    expect(dockerignore).toContain('*.key');
    expect(dockerignore).toContain('posthorn-data');
    expect(dockerignore).toContain('*.sqlite');
    expect(dockerignore).toContain('*.db');
    expect(dockerignore).toContain('node_modules');
    expect(dockerignore).toContain('roadmap');
  });

  it('defines a compose reference with one app, a data volume, and Prometheus scraping', () => {
    const compose = read('docker-compose.yml');
    const prometheus = read('docs/prometheus.yml');

    expect(compose).toContain('posthorn:');
    expect(compose).toContain(['127.0.0.1:', '{POSTHORN_PORT:-3000}:3000'].join('$'));
    expect(compose).toContain('POSTHORN_DATA_DIR: /data');
    expect(compose).toContain('POSTHORN_ADMIN_TOKEN: ${POSTHORN_ADMIN_TOKEN:?');
    expect(compose).toContain('posthorn-data:/data');
    expect(compose).toContain('prometheus:');
    expect(compose).toContain('prom/prometheus:');
    expect(compose).toContain(['127.0.0.1:', '{PROMETHEUS_PORT:-9090}:9090'].join('$'));
    expect(compose).toContain('./docs/prometheus.yml:/etc/prometheus/prometheus.yml:ro');
    expect(compose).toContain('no-new-privileges:true');
    expect(lower(compose)).not.toContain('redis');
    expect(lower(compose)).not.toContain('postgres');
    expect(lower(compose)).not.toContain('posthorn_admin_token=');

    expect(prometheus).toContain('metrics_path: /metrics');
    expect(prometheus).toContain('posthorn:3000');
  });

  it('documents runnable smoke checks without referring to an unimplemented admin CLI', () => {
    const docs = read('docs/DEPLOY.md');
    const readme = read('README.md');

    expect(docs).toContain('docker build -t posthorn:local .');
    expect(docs).toContain('docker run -d --name posthorn-smoke');
    expect(docs).toContain('-p 127.0.0.1:3000:3000');
    expect(docs).toContain('curl -fsS http://localhost:3000/healthz');
    expect(docs).toContain('docker compose up -d --build');
    expect(docs).toContain('binds both host ports to `127.0.0.1`');
    expect(docs).toContain('POSTHORN_ADMIN_TOKEN');
    expect(docs).toContain('Avoid sharing `docker compose config` output');
    expect(docs).not.toContain('posthorn admin');

    expect(readme).toContain('docker build -t posthorn .');
    expect(readme).toContain('-p 127.0.0.1:3000:3000');
    expect(readme).toContain('localhost:3000/v1/endpoints');
    expect(readme).toContain('curl -fsS localhost:3000/healthz');
    expect(readme).toContain('admin create-app');
    expect(readme).toContain('POSTHORN_ADMIN_TOKEN');
    expect(readme).not.toContain('posthorn admin');
    expect(readme).not.toContain('.env.example');
    expect(readme).not.toContain('ready-made alerting rules');
  });
});

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function lower(value: string): string {
  return value.toLowerCase();
}
