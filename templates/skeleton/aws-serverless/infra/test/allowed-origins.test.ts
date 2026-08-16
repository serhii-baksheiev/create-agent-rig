import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AppStack, type AppStackProps } from '../lib/app-stack.js';

// Who may call the API is a security decision with exactly two safe outcomes:
// the right origins, or a refusal loud enough that somebody fixes it. An empty
// allow-list is neither — it synthesises, deploys, and blocks every call.

const buildAppStack = (options: { context?: Record<string, unknown>; props?: AppStackProps } = {}) =>
  new AppStack(new App({ context: options.context }), 'TestStack', options.props);

const originsOf = (options: Parameters<typeof buildAppStack>[0]): unknown[] => {
  const apis = Template.fromStack(buildAppStack(options)).findResources('AWS::ApiGatewayV2::Api');
  return Object.values(apis).flatMap(
    (api) =>
      (api.Properties as { CorsConfiguration?: { AllowOrigins?: unknown[] } }).CorsConfiguration
        ?.AllowOrigins ?? [],
  );
};

const thrownBy = (build: () => unknown): unknown => {
  try {
    build();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('choosing the allowed origins', () => {
  it('prefers the origins passed in props over the localhost default', () => {
    expect(originsOf({ props: { allowedOrigins: ['https://app.example.com'] } })).toEqual([
      'https://app.example.com',
    ]);
  });

  it('reads a comma-separated -c allowedOrigins as one origin each, trimmed', () => {
    expect(
      originsOf({ context: { allowedOrigins: ' https://a.example.com , https://b.example.com ' } }),
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
  });
});

describe('an allow-list that names nobody is a broken deploy, not a default', () => {
  it('refuses a context value that parses to no origin at all', () => {
    // `-c allowedOrigins=" , , "` is a typo, and today it synthesises an API
    // with an empty allow-list: every browser call fails, and the only obvious
    // repair a hurried reader finds is putting `*` back.
    const error = thrownBy(() => buildAppStack({ context: { allowedOrigins: ' , , ' } }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message, 'the message must name the flag that was wrong').toMatch(
      /allowedOrigins/,
    );
  });

  it('refuses an explicitly empty allowedOrigins prop for the same reason', () => {
    // `?? DEFAULT` does not catch `[]` — an empty array is not nullish, so it
    // travels all the way to CorsConfiguration.
    const error = thrownBy(() => buildAppStack({ props: { allowedOrigins: [] } }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/allowedOrigins/);
  });

  it('refuses a non-string context value instead of crashing inside the stack', () => {
    // `cdk.json` holds JSON, so `"allowedOrigins": ["https://a"]` is a natural
    // thing to write. Chosen behaviour: REFUSE it and name the flag — one code
    // path for "the flag was given something unusable", rather than quietly
    // widening what the stack accepts.
    const error = thrownBy(() =>
      buildAppStack({ context: { allowedOrigins: ['https://a.example.com'] } }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/allowedOrigins/);
    expect(
      (error as Error).message,
      'a TypeError from .split is a crash, not a refusal',
    ).not.toMatch(/is not a function/);
  });
});
