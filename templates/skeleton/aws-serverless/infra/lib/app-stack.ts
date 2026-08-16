import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Annotations,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Token,
  type StackProps,
} from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '..', '..');

export interface AppStackProps extends StackProps {
  /**
   * Browser origins allowed to call the API.
   *
   * `bin/app.ts` passes the CloudFront origin from `WebStack`, so a deployed
   * app works without configuring anything. Pass this (or
   * `-c allowedOrigins=https://…`, comma-separated, which the entrypoint
   * prefers when given) for a custom domain, a staging origin, or several.
   */
  allowedOrigins?: string[];
}

/** Local dev only: a real origin is a deliberate act, not a default. */
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000'];

/**
 * Props win, then `-c allowedOrigins=a,b`, then the local default.
 *
 * Anything given but unusable — an empty list, a context value that trims away
 * to nothing, a value that is not a string — throws rather than falling back.
 * The failure this prevents is silent: an API synthesised with an empty
 * allow-list blocks every browser call, and the symptom appears far from the
 * flag that caused it.
 *
 * Exported for the tests, and only for them — nothing else imports it. The
 * alternative was a case per branch built on its own `AppStack`, which cost a
 * full synth and three Lambda bundles each and put the generated project's
 * suite over its hook timeout.
 */
export function resolveAllowedOrigins(fromProps: string[] | undefined, fromContext: unknown): string[] {
  if (fromProps !== undefined) {
    if (fromProps.length === 0) {
      throw new Error('allowedOrigins was given as an empty list — name an origin, or omit it');
    }
    return fromProps.map(checkedOrigin);
  }
  if (nothingGiven(fromContext)) return DEFAULT_ALLOWED_ORIGINS;
  if (typeof fromContext !== 'string') {
    throw new Error(
      `allowedOrigins must be a comma-separated string, got ${typeof fromContext} — ` +
        'use -c allowedOrigins=https://example.com',
    );
  }
  const origins = fromContext
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error(`allowedOrigins parsed to no origin at all from ${JSON.stringify(fromContext)}`);
  }
  return origins.map(checkedOrigin);
}

/**
 * Whether the caller supplied nothing. Exported because `bin/app.ts` decides
 * the same question about the same value, and two spellings of "nothing given"
 * is how a `null` in `cdk.json` ends up meaning "the operator chose an origin"
 * in one file and "use the default" in the other.
 */
export function nothingGiven(contextValue: unknown): boolean {
  return contextValue === undefined || contextValue === null;
}

/**
 * An origin a browser could actually send: `*`, or a scheme plus a host.
 *
 * The check exists because the near-misses synthesise green and fail in the
 * browser, far from the flag that caused them — `app.example.com` with the
 * scheme left off is the likeliest of them, since an `Origin` header always
 * carries one.
 */
function checkedOrigin(origin: string): string {
  if (origin === '*') return origin;
  // A cross-stack origin is a token here and a domain only at deploy time —
  // there is nothing to parse yet, and refusing it would refuse the wiring
  // this stack ships with.
  if (Token.isUnresolved(origin)) return origin;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(
      `allowedOrigins entry ${JSON.stringify(origin)} is not an origin — ` +
        'a browser sends scheme://host[:port], as in https://app.example.com',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`allowedOrigins entry ${JSON.stringify(origin)} is not an http(s) origin`);
  }
  // The NORMALISED form, not what was typed: a trailing slash, an uppercase
  // scheme, a path, a unicode host or a redundant :443 all synthesise green and
  // then match no Origin header a browser sends.
  return parsed.origin;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props?: AppStackProps) {
    super(scope, id, props);

    const allowedOrigins = resolveAllowedOrigins(
      props?.allowedOrigins,
      this.node.tryGetContext('allowedOrigins'),
    );

    // `*` is honoured — an operator who typed it into a flag has chosen it, and
    // refusing would push them to edit this stack instead, which is worse. It
    // does not get to be quiet about it: the whole point of not shipping the
    // wildcard is that reaching for it should be a visible act.
    if (allowedOrigins.includes('*')) {
      // V2 because it can be acknowledged: `addWarning` hard-blocks
      // `cdk synth --strict`, which would turn "loud" into "refused" for an
      // operator who chose the wildcard deliberately.
      Annotations.of(this).addWarningV2(
        '@app/allowed-origins:wildcard',
        'allowedOrigins includes "*": every site may call this API from a browser. ' +
          'Name the origins instead unless this is a throwaway environment.',
      );
    }

    // --- storage: one single-table DynamoDB table --------------------------
    const table = new Table(this, 'NotesTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // Skeleton default: destroyable. Flip to RETAIN before storing real data.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- queue with DLQ + alarm -------------------------------------------
    const deadLetterQueue = new Queue(this, 'NotesDlq', {
      retentionPeriod: Duration.days(14),
    });
    const queue = new Queue(this, 'NotesQueue', {
      visibilityTimeout: Duration.seconds(30),
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
    });
    deadLetterQueue
      .metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) })
      .createAlarm(this, 'DlqNotEmptyAlarm', {
        alarmDescription: 'A message reached the DLQ — a consumer is failing.',
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });

    // --- functions ---------------------------------------------------------
    const bundling = { sourceMap: false } as const;
    const apiFunction = new NodejsFunction(this, 'CreateNoteFunction', {
      entry: path.join(workspaceRoot, 'services', 'api', 'src', 'main.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      depsLockFilePath: path.join(workspaceRoot, 'pnpm-lock.yaml'),
      bundling,
      environment: {
        TABLE_NAME: table.tableName,
        QUEUE_URL: queue.queueUrl,
      },
    });

    const listFunction = new NodejsFunction(this, 'ListNotesFunction', {
      entry: path.join(workspaceRoot, 'services', 'api', 'src', 'list-main.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      depsLockFilePath: path.join(workspaceRoot, 'pnpm-lock.yaml'),
      bundling,
      environment: {
        TABLE_NAME: table.tableName,
      },
    });

    const workerFunction = new NodejsFunction(this, 'NoteCreatedWorker', {
      entry: path.join(workspaceRoot, 'services', 'worker', 'src', 'main.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      depsLockFilePath: path.join(workspaceRoot, 'pnpm-lock.yaml'),
      bundling,
    });
    workerFunction.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));

    // --- least-privilege grants: exactly what each function does ----------
    table.grantWriteData(apiFunction); // the creator only puts
    queue.grantSendMessages(apiFunction); // and publishes
    table.grantReadData(listFunction); // the lister only reads

    // --- the HTTP routes ---------------------------------------------------
    // CORS: the web bundle is served from another origin (CloudFront), so the
    // API has to name who may call it. `*` is not that name — a starter
    // multiplies whatever it ships, and a wildcard here becomes the default of
    // every project generated from it.
    const httpApi = new HttpApi(this, 'NotesApi', {
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
        allowHeaders: ['content-type'],
      },
    });
    httpApi.addRoutes({
      path: '/notes',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('CreateNoteIntegration', apiFunction),
    });
    httpApi.addRoutes({
      path: '/notes',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('ListNotesIntegration', listFunction),
    });

    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'DlqUrl', { value: deadLetterQueue.queueUrl });
  }
}
