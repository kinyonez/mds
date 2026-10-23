import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { NoteMeta } from '../domain/frontmatter';
import type { NotesIndex } from '../domain/types';

export interface NoteRecord {
  id: string;
  /** front matter 込みの生テキスト */
  content: string;
  /** 解析済みの front matter（解析できなければ最低限の値） */
  meta: NoteMeta;
  localUpdated: number;
  /** 最後に PUT が成功した時刻。index の generatedAt と比べてラグを判定する */
  syncedAt?: number;
  /** サーバーに未送信の変更がある */
  dirty: boolean;
  /** 完全削除済み。index から消えるまで非表示にする */
  deleted?: boolean;
  /** 完全削除をまだリモートに反映していない */
  purge?: boolean;
  /** 解決待ちの競合（リモート版） */
  conflict?: { content: string; sha: string };
  parseError?: string;
}

export interface BaseRecord {
  id: string;
  content: string;
  sha: string;
}

export interface IndexRecord {
  key: 'current';
  data: NotesIndex;
  etag?: string;
  fetchedAt: number;
}

export type QueueOp =
  | { op: 'put'; ids: [string] }
  | { op: 'delete'; ids: string[] }
  | { op: 'batch'; ids: string[]; message: string; folders?: boolean }
  | { op: 'folders'; ids: [] }
  | { op: 'attach'; ids: [string]; key: string }
  /** 未コミットの変更（ノート・添付・folders.json・完全削除）をすべて 1 コミットにまとめる */
  | { op: 'sync'; ids: [] };

export type QueueItem = QueueOp & {
  seq?: number;
  attempts: number;
  nextAt: number;
  lastError?: string;
};

export interface AttachmentRecord {
  /** noteId/filename */
  key: string;
  noteId: string;
  filename: string;
  blob: Blob;
  /** 未送信 */
  dirty: boolean;
}

/**
 * _meta/folders.json へのローカルの差分。index.json に反映されるまで保持し、
 * 表示上は「index の folders ∪ add − remove」とする。
 */
export interface FoldersRecord {
  add: string[];
  remove: string[];
  /** フォルダのリネーム（from → to）。リモートの一覧にも適用する */
  renames?: [string, string][];
  /** 未送信 */
  dirty: boolean;
}

interface Schema extends DBSchema {
  notes: { key: string; value: NoteRecord; indexes: { folder: string; tags: string; localUpdated: number } };
  base: { key: string; value: BaseRecord };
  index: { key: string; value: IndexRecord };
  queue: { key: number; value: QueueItem; indexes: { nextAt: number } };
  attachments: { key: string; value: AttachmentRecord; indexes: { noteId: string } };
  settings: { key: string; value: unknown };
}

export type DB = IDBPDatabase<Schema>;

export const DB_NAME = 'notes-app';

export async function openDb(name = DB_NAME): Promise<DB> {
  return openDB<Schema>(name, 1, {
    upgrade(db) {
      const notes = db.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('folder', 'meta.folder');
      notes.createIndex('tags', 'meta.tags', { multiEntry: true });
      notes.createIndex('localUpdated', 'localUpdated');
      db.createObjectStore('base', { keyPath: 'id' });
      db.createObjectStore('index', { keyPath: 'key' });
      const q = db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      q.createIndex('nextAt', 'nextAt');
      const a = db.createObjectStore('attachments', { keyPath: 'key' });
      a.createIndex('noteId', 'noteId');
      db.createObjectStore('settings');
    },
  });
}

export class Store {
  constructor(readonly db: DB) {}

  getNote(id: string) {
    return this.db.get('notes', id);
  }
  putNote(n: NoteRecord) {
    return this.db.put('notes', n);
  }
  deleteNote(id: string) {
    return this.db.delete('notes', id);
  }
  allNotes() {
    return this.db.getAll('notes');
  }
  getBase(id: string) {
    return this.db.get('base', id);
  }
  putBase(b: BaseRecord) {
    return this.db.put('base', b);
  }
  deleteBase(id: string) {
    return this.db.delete('base', id);
  }
  allBases() {
    return this.db.getAll('base');
  }
  getIndex() {
    return this.db.get('index', 'current');
  }
  putIndex(r: Omit<IndexRecord, 'key'>) {
    return this.db.put('index', { key: 'current', ...r });
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await this.db.get('settings', key)) as T | undefined;
  }
  setSetting(key: string, value: unknown) {
    return this.db.put('settings', value, key);
  }
  deleteSetting(key: string) {
    return this.db.delete('settings', key);
  }

  getFolders() {
    return this.getSetting<FoldersRecord>('folders');
  }
  putFolders(f: FoldersRecord) {
    return this.setSetting('folders', f);
  }

  getAttachment(key: string) {
    return this.db.get('attachments', key);
  }
  putAttachment(a: AttachmentRecord) {
    return this.db.put('attachments', a);
  }
  allAttachments() {
    return this.db.getAll('attachments');
  }
  attachmentsOf(noteId: string) {
    return this.db.getAllFromIndex('attachments', 'noteId', noteId);
  }
  deleteAttachment(key: string) {
    return this.db.delete('attachments', key);
  }

  /** 全データ削除（ログアウト時に選択） */
  async clearAll(keepSettings: boolean) {
    const stores = ['notes', 'base', 'index', 'queue', 'attachments'] as const;
    for (const s of stores) await this.db.clear(s);
    if (!keepSettings) await this.db.clear('settings');
  }
}
