// The queue between api and worker is a spool directory: one JSON file per
// event. Same DLQ discipline as any queue — the worker moves poison files to
// the DLQ directory after its retry budget.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NoteCreatedEvent } from '@app/core';
import type { EventPublisher } from '../usecases/create-note.js';

export class SpoolEventPublisher implements EventPublisher {
  constructor(
    private readonly queueDir: string,
    /** Unique, sortable message name — injected so tests stay deterministic. */
    private readonly nextName: () => string,
  ) {}

  async publish(event: NoteCreatedEvent): Promise<void> {
    await mkdir(this.queueDir, { recursive: true });
    const file = path.join(this.queueDir, `${this.nextName()}.json`);
    // Write-then-rename so the worker never picks up a half-written message.
    await writeFile(`${file}.tmp`, JSON.stringify(event));
    await rename(`${file}.tmp`, file);
  }
}
