// The model boundary, same contract as any other target — only the medium
// differs: one JSON file. This is the ONLY module that knows how notes are
// persisted; nothing else composes a path into the data file.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NoteSchema, type Note } from '@app/core';
import { AppError, NotFoundError } from '@app/shared';

type NoteTable = Record<string, unknown>;

export class JsonFileNoteStore {
  /**
   * Writes run one at a time — **per instance, which is the whole extent of
   * it**. A write is load → mutate → save, and that is not atomic: two
   * concurrent `put()`s would both read the same table and the second save
   * would drop the first note. This chain serialises the ones going through
   * *this* object. Two `JsonFileNoteStore`s over the same file lose notes to
   * each other exactly as before — in one process as readily as in two — so
   * share the instance, and reach for a real lock before sharing the file.
   */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async put(note: Note): Promise<void> {
    return this.serialised(async () => {
      const table = await this.load();
      if (note.id in table) {
        throw new AppError(`note ${note.id} already exists`, { code: 'CONFLICT', statusCode: 409 });
      }
      table[note.id] = note;
      await this.save(table);
    });
  }

  async get(id: string): Promise<Note> {
    const table = await this.load();
    const raw = table[id];
    if (raw === undefined) {
      throw new NotFoundError(`note ${id} not found`);
    }
    // Validate on the way out: the file is an external system.
    return NoteSchema.parse(raw);
  }

  async list(): Promise<Note[]> {
    const table = await this.load();
    // Validate every entry — silently skipping corruption would hide data loss.
    return Object.values(table)
      .map((raw) => NoteSchema.parse(raw))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Queues `work` behind the writes already in flight on this instance. */
  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work);
    // The caller gets the rejection; the chain gets a settled promise. Without
    // this line one failed write (a 409, say) would reject every write queued
    // behind it, and this store object would stay broken for as long as it is
    // held — the chain is per instance, so a fresh store would still work.
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<NoteTable> {
    let content: string;
    try {
      content = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    try {
      return JSON.parse(content) as NoteTable;
    } catch (cause) {
      throw new AppError(`data file ${this.file} is corrupt`, { code: 'DATA_CORRUPT', cause });
    }
  }

  private async save(table: NoteTable): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    // Write-then-rename keeps readers from ever seeing a half-written file.
    // The temp name is unique per write: a shared one lets two writers scribble
    // over each other's file and lose a rename to ENOENT.
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(table, null, 2));
      await rename(tmp, this.file);
    } catch (error) {
      // Best-effort tidy-up: a failure to remove the temp file must not
      // replace the failure that actually matters.
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
