// The one place that touches the queue SDK on the sending side.
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { NoteCreatedEvent } from '@app/core';
import type { EventPublisher } from '../usecases/create-note.js';

/** Structural view of the SQS client — tests stub it. */
export interface QueueClient {
  send(command: unknown): Promise<unknown>;
}

export function createQueueClient(): QueueClient {
  return new SQSClient({}) as QueueClient;
}

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: QueueClient,
    private readonly queueUrl: string,
  ) {}

  async publish(event: NoteCreatedEvent): Promise<void> {
    await this.client.send(
      new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(event) }),
    );
  }
}
