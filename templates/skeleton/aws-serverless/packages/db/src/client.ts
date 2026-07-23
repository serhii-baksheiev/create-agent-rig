// The ONLY file in the project that constructs the storage SDK client.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Structural view of the document client — models depend on this, tests stub it.
 * (Method parameters are bivariant, so the real client satisfies it.)
 */
export interface DocumentClient {
  send(command: unknown): Promise<unknown>;
}

export function createDocumentClient(): DocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }) as DocumentClient;
}
