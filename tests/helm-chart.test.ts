import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHART_DIR = 'charts/posthorn';
const REQUIRED_FILES = [
  'Chart.yaml',
  'values.yaml',
  'templates/_helpers.tpl',
  'templates/secret.yaml',
  'templates/pvc.yaml',
  'templates/deployment.yaml',
  'templates/service.yaml',
  'templates/NOTES.txt',
] as const;

describe('Helm chart deployment reference', () => {
  it('includes the required chart files for Posthorn', () => {
    for (const file of REQUIRED_FILES) {
      expect(existsSync(join(CHART_DIR, file)), file).toBe(true);
    }

    const chart = read('Chart.yaml');
    expect(chart).toContain('apiVersion: v2');
    expect(chart).toContain('name: posthorn');
    expect(chart).toContain('type: application');
    expect(chart).toContain('appVersion: "0.0.0"');
  });

  it('defaults to one SQLite-backed Posthorn pod with persistent data', () => {
    const values = read('values.yaml');
    const deployment = read('templates/deployment.yaml');
    const pvc = read('templates/pvc.yaml');
    const service = read('templates/service.yaml');

    expect(values).not.toContain('replicaCount');
    expect(values).toContain('repository: posthorn');
    expect(values).toContain('pullPolicy: IfNotPresent');
    expect(values).toContain('type: ClusterIP');
    expect(values).toContain('port: 3000');
    expect(values).toContain('enabled: true');
    expect(values).toContain('size: 1Gi');
    expect(deployment).toContain('replicas: 1');
    expect(deployment).toContain('automountServiceAccountToken: false');
    expect(values).toContain('readOnlyRootFilesystem: true');
    expect(deployment).toContain('containerPort: 3000');
    expect(deployment).toContain('name: POSTHORN_DATA_DIR');
    expect(deployment).toContain('value: /data');
    expect(deployment).toContain('mountPath: /data');
    expect(pvc).toContain('kind: PersistentVolumeClaim');
    expect(pvc).toContain('storage: {{ .Values.persistence.size | quote }}');
    expect(service).toContain('kind: Service');
    expect(service).toContain('type: {{ .Values.service.type }}');
    expect(service).toContain('targetPort: http');
  });

  it('uses implemented probes and Secret-based admin token wiring', () => {
    const deployment = read('templates/deployment.yaml');
    const secret = read('templates/secret.yaml');
    const values = read('values.yaml');

    expect(deployment).toContain('path: /healthz');
    expect(deployment).toContain('path: /readyz');
    expect(deployment).toContain('name: POSTHORN_ADMIN_TOKEN');
    expect(deployment).toContain('secretKeyRef:');
    expect(deployment).toContain('name: {{ include "posthorn.adminSecretName" . }}');
    expect(deployment).toContain('key: {{ .Values.admin.existingSecretKey }}');
    expect(secret).toContain('kind: Secret');
    expect(secret).toContain('{{- if and .Values.admin.createSecret (not .Values.admin.existingSecret) }}');
    expect(secret).toContain('required "admin.token is required');
    expect(values).toContain('existingSecret: ""');
    expect(values).toContain('existingSecretKey: posthorn-admin-token');
    expect(values).toContain('createSecret: false');
    expect(values).toContain('token: ""');
    expect(chartText()).not.toContain('POSTHORN_ADMIN_TOKEN=');
    expect(chartText()).not.toContain('phk_');
    expect(chartText()).not.toContain('whsec_');
  });

  it('does not claim unsupported Kubernetes or scale-out integrations', () => {
    const files = allChartFiles();
    const names = files.map((file) => file.replace(/\\/g, '/')).join('\n').toLowerCase();
    const content = chartText().toLowerCase();

    expect(names).not.toContain('ingress');
    expect(names).not.toContain('servicemonitor');
    expect(names).not.toContain('hpa');
    expect(content).not.toContain('kind: ingress');
    expect(content).not.toContain('kind: servicemonitor');
    expect(content).not.toContain('kind: horizontalpodautoscaler');
    expect(content).not.toContain('redis');
    expect(content).not.toContain('postgres');
    expect(content).not.toContain('replicas: 2');
  });

  it('links the chart from deployment docs with the current product boundary', () => {
    const docs = readFileSync('docs/DEPLOY.md', 'utf8');
    const readme = readFileSync('README.md', 'utf8');

    expect(docs).toContain('charts/posthorn');
    expect(docs).toContain('helm install');
    expect(docs).toContain('admin.existingSecret');
    expect(docs).toContain('single-pod');
    expect(docs).toContain('SQLite');
    expect(docs).toContain('PostgreSQL backend is not implemented yet');
    expect(readme).toContain('Docker Compose, and a starter Helm chart');
    expect(readme).toContain('starter Helm');
    expect(readme).toContain('single-pod SQLite Kubernetes reference');
    expect(readme).toContain('PostgreSQL-backed scale-out remains future work');
    expect(readme).toContain('docs/DEPLOY.md');
  });
});

function read(path: string): string {
  return readFileSync(join(CHART_DIR, path), 'utf8');
}

function chartText(): string {
  return allChartFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

function allChartFiles(dir = CHART_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? allChartFiles(path) : [path];
  });
}
