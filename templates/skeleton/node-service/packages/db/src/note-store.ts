// The model boundary, same contract as any other target — only the medium
// differs: one JSON file. This is the ONLY module that knows how notes are
// persisted; nothing else composes a path into the data file.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NoteSchema, type Note } from '@app/core';
import { AppError, NotFoundError } from '@app/shared';

type NoteTable = Record<string, unknown>;

export class JsonFileNoteStore {
  constructor(private readonly file: string) {}

  async put(note: Note): Promise<void> {
    const table = await this.load();
    if (note.id in table) {
      throw new AppError(`note ${note.id} already exists`, { code: 'CONFLICT', statusCode: 409 });
    }
    table[note.id] = note;
    await this.save(table);
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
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(table, null, 2));
    await rename(tmp, this.file);
  }
}
