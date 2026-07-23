import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wf = (target: string, name: string) =>
  path.join(repoRoot, 'templates', 'skeleton', target, '.github', 'workflows', name);

const STATIC_KEY_MARKERS = [
  'aws-access-key-id',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'secret-access-key',
];

// CD brief: aws-serverless gets a real DEV deploy over OIDC (no static keys),
// degrading cleanly with no credentials; node-service builds an artifact and
// stops short of delivery. No production path in either — production is human.
describe('aws-serverless deploy workflow', () => {
  let yaml: string;

  it('exists and deploys via cdk (dev)', async () => {
    yaml = await readFile(wf('aws-serverless', 'deploy.yml'), 'utf8');
    expect(yaml).toMatch(/cdk deploy/);
  });

  it('authenticates with OIDC and ships NO static keys', async () => {
    yaml = await readFile(wf('aws-serverless', 'deploy.yml'), 'utf8');
    expect(yaml).toMatch(/id-token:\s*write/);
    expect(yaml).toMatch(/configure-aws-credentials/);
    expect(yaml).toMatch(/role-to-assume/);
    for (const marker of STATIC_KEY_MARKERS) {
      expect(yaml, marker).not.toContain(marker);
    }
  });

  it('degrades cleanly with no credentials: skips with a message, never fails', async () => {
    yaml = await readFile(wf('aws-serverless', 'deploy.yml'), 'utf8');
    expect(yaml).toMatch(/skip/i);
    expect(yaml).toMatch(/no credentials|not configured|see README/i);
    // the deploy steps are gated on the guard, so absent-secret ⇒ nothing runs
    expect(yaml).toMatch(/steps\.\w+\.outputs\.skip/);
    // enabling is "add a secret", encoded as a repo secret reference
    expect(yaml).toMatch(/secrets\.AWS_DEPLOY_ROLE_ARN/);
  });

  it('has no production path (dev only — the Never tier forbids agent prod deploys)', async () => {
    yaml = await readFile(wf('aws-serverless', 'deploy.yml'), 'utf8');
    expect(yaml.toLowerCase()).not.toMatch(/environment:\s*production/);
    expect(yaml.toLowerCase()).not.toContain('prod deploy');
  });
});

describe('node-service artifact workflow', () => {
  let yaml: string;

  it('builds a runnable artifact and stops short of delivery', async () => {
    yaml = await readFile(wf('node-service', 'deploy.yml'), 'utf8');
    expect(yaml).toMatch(/build:artifact/);
    expect(yaml).toMatch(/upload-artifact/);
    // no destination baked in: no registry push, no cloud auth
    expect(yaml).not.toMatch(/docker push|configure-aws-credentials/);
    for (const marker of STATIC_KEY_MARKERS) {
      expect(yaml, marker).not.toContain(marker);
    }
  });

  it('names the destination as the owner’s choice, not a stub', async () => {
    yaml = await readFile(wf('node-service', 'deploy.yml'), 'utf8');
    expect(yaml).not.toMatch(/fill this in|TODO|FIXME/i);
    expect(yaml).toMatch(/your choice|owner|see README/i);
  });
});

describe('the tool’s own repository never deploys', () => {
  it('root workflows run checks only — no cdk deploy, no artifact upload', async () => {
    for (const name of ['ci.yml', 'template-freshness.yml']) {
      const yaml = await readFile(path.join(repoRoot, '.github', 'workflows', name), 'utf8');
      expect(yaml, name).not.toMatch(/cdk deploy/);
      expect(yaml, name).not.toMatch(/upload-artifact/);
    }
  });
});
