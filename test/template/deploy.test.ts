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

  // A deploy that builds a bundle and never ships it is worse than no deploy:
  // CloudFront keeps serving the previous one, and the green run says it went
  // fine. WebStack deliberately has no BucketDeployment (synth must not depend
  // on `next build` having run), so delivery is the workflow's job.
  it('uploads the built web bundle and invalidates the edge cache', async () => {
    yaml = await readFile(wf('aws-serverless', 'deploy.yml'), 'utf8');
    expect(yaml).toMatch(/aws s3 sync/);
    expect(yaml).toMatch(/apps\/web\/out/);
    expect(yaml).toMatch(/create-invalidation/);
  });

  it('uploads the bundle after building it, never before', async () => {
    yaml = await readFile(wf('aws-serverless', 'deploy.yml'), 'utf8');
    // steps run top to bottom, so file order is execution order
    expect(yaml.indexOf('build:web')).toBeLessThan(yaml.indexOf('aws s3 sync'));
  });

  it('reads the destination from the stack outputs, never a baked-in bucket name', async () => {
    yaml = await readFile(wf('aws-serverless', 'deploy.yml'), 'utf8');
    expect(yaml).toMatch(/WebBucketName/);
    expect(yaml).toMatch(/outputs-file|describe-stacks/);
  });

  it('gates the upload on the same credentials guard as every other step', async () => {
    yaml = await readFile(wf('aws-serverless', 'deploy.yml'), 'utf8');
    const steps = yaml.split(/\n\s*- (?=if:|id:|uses:|run:|name:)/);
    const upload = steps.filter((step) => /aws s3 sync|create-invalidation/.test(step));
    expect(upload.length).toBeGreaterThan(0);
    for (const step of upload) {
      // an ungated step turns "skips cleanly with no credentials" into a red X
      expect(step, step.split('\n')[0]).toMatch(/steps\.\w+\.outputs\.skip/);
    }
  });

  // GitHub's implicit shell is `bash -e {0}`: no `pipefail`, no `-u`. So a
  // failing command inside a pipeline is invisible, and an unset variable
  // expands to nothing — both of which the step below turns into an `aws s3`
  // command aimed somewhere nobody chose.
  describe('the upload step cannot be talked into deleting somebody else’s bucket', () => {
    /** The `run:` body of the step that ships the bundle. */
    const uploadScript = async (): Promise<string> => {
      const yaml = await readFile(wf('aws-serverless', 'deploy.yml'), 'utf8');
      const steps = yaml.split(/\n\s*- (?=if:|id:|uses:|run:|name:)/);
      const upload = steps.filter((step) => /aws s3 sync/.test(step));
      expect(upload.length, 'no step syncs the bundle at all').toBe(1);
      return upload[0]!;
    };

    it('runs under -euo pipefail, not the implicit bash -e GitHub supplies', async () => {
      expect(await uploadScript()).toMatch(/set -euo pipefail/);
    });

    it('stops when a stack output is missing, instead of resolving it to the string null', async () => {
      // `jq -r` prints `null` and exits 0, so a renamed output becomes
      // `aws s3 sync apps/web/out s3://null --delete` — an upload into a
      // stranger's bucket in a global namespace, followed by deletes.
      const script = await uploadScript();
      // Comment lines are excluded on purpose: the step explains this very trap
      // in prose, and a flag check that reads prose reports the explanation as
      // the defect it warns about.
      const jqLines = script
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .filter((line) => /\bjq\b/.test(line));
      expect(jqLines.length, 'the destination is read with jq').toBeGreaterThan(0);
      for (const line of jqLines) {
        const flags = line.match(/(?<=\s)--?[A-Za-z-]+/g) ?? [];
        expect(
          flags.some((flag) => flag === '--exit-status' || /^-[a-z]*e[a-z]*$/.test(flag)),
          `no --exit-status on: ${line.trim()}`,
        ).toBe(true);
      }
    });

    it('refuses to sync a bundle directory with nothing in it', async () => {
      // `apps/web/out` existing but empty is the ordinary shape of a failed or
      // skipped build. Syncing it uploads zero objects, and `--delete` then
      // removes every object already live: the site is wiped by a green run.
      const script = await uploadScript();
      const lines = script.split('\n');
      const syncAt = lines.findIndex((line) => /aws s3 sync/.test(line));
      const before = lines.slice(0, syncAt);
      expect(
        before.some((line) => /ls -A|find |-empty|wc -l/.test(line)),
        'nothing checks the bundle directory has contents before the sync',
      ).toBe(true);
      expect(
        before.join('\n'),
        'an emptiness check that does not stop the step is decoration',
      ).toMatch(/exit [1-9]/);
    });
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
