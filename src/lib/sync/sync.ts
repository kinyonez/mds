import { FrontMatterError } from '../domain/frontmatter';
import {
  TRASH,
  createNoteContent,
  displayTitle,
  excerpt,
  extractLinks,
  isTrashed,
  moveToTrash,
  normalizeFolder,
  normalizeTag,
  notePath,
  parseNote,
  replaceFolderPrefix,
  restoreFromTrash,
  timeOf,
  updateMeta,
} from '../domain/note';
import { expandPaths } from '../domain/tree';
import { EMPTY_INDEX, type IndexNote, type NoteSummary, type NotesIndex } from '../domain/types';
import type { FoldersRecord, NoteRecord, QueueItem, Store } from '../store/db';
import type { Queue } from '../store/queue';
import { GitHubClient, GitHubError, bytesToBase64, type TreeChange } from './github';
import { mergeNote } from './merge';

export type NoteStatus = 'local' | 'syncing' | 'synced' | 'conflict' | 'offline';

export type PauseReason = 'auth' | 'forbidden' | 'notfound' | 'ratelimit';

/**
 * auto: 編集停止から 3 秒でノートごとにコミットする。
 * manual: 定期同期は pull（index 取得）だけ。commitNow() で未コミットの変更をまとめて 1 コミットにする。
 */
export type SyncMode = 'auto' | 'manual';

export interface EngineState {
  online: boolean;
  configured: boolean;
  syncing: boolean;
  /** 処理中のノート id */
  inflight: string[];
  pending: number;
  mode: SyncMode;
  /** 未コミットの変更件数（ノート・添付・folders.json・完全削除） */
  changes: number;
  paused: { reason: PauseReason; message: string; until?: number } | null;
  lastError?: string;
  lastIndexAt?: number;
  /** index.json が見つからない（データリポ未初期化） */
  indexMissing: boolean;
  /** index の世代。UI の再計算トリガー */
  version: number;
}

type Listener = (s: EngineState) => void;

export interface EngineOptions {
  now?: () => number;
  /** タイマー。テストでは差し替える */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

const FOLDERS_PATH = '_meta/folders.json';

class ConflictPending extends Error {}

export function recordFromContent(id: string, content: string, now: number, dirty: boolean): NoteRecord {
  try {
    const { meta } = parseNote(content, id);
    return { id, content, meta, localUpdated: now, dirty };
  } catch (e) {
    return {
      id,
      content,
      meta: { id, title: '', folder: '', tags: [], created: '', updated: '' },
      localUpdated: now,
      dirty,
      parseError: e instanceof FrontMatterError ? e.message : String(e),
    };
  }
}

function summaryFromRecord(r: NoteRecord): NoteSummary {
  let body = '';
  try {
    body = parseNote(r.content, r.id).body;
  } catch {
    body = r.content;
  }
  return {
    id: r.id,
    title: displayTitle(r.meta, body),
    folder: r.meta.folder ?? '',
    tags: r.meta.tags ?? [],
    created: r.meta.created,
    updated: r.meta.updated,
    excerpt: excerpt(body),
    links: extractLinks(body),
    error: r.parseError,
    trashedAt: r.meta.trashedAt as string | undefined,
    trashedFrom: r.meta.trashedFrom as string | undefined,
    local: true,
  };
}

function summaryFromIndex(n: IndexNote): NoteSummary {
  return {
    id: n.id,
    title: n.title || displayTitle({}, n.excerpt),
    folder: n.folder ?? '',
    tags: n.tags ?? [],
    created: n.created,
    updated: n.updated,
    excerpt: n.excerpt ?? '',
    links: n.links ?? [],
    error: n.error,
    trashedAt: n.trashedAt,
    trashedFrom: n.trashedFrom,
    local: false,
  };
}

/** 集合としてのマージ: (rename(remote) ∪ add) − remove（remove は配下も含む） */
export function applyFolderSet(remote: string[], add: string[], remove: string[], renames: [string, string][] = []): string[] {
  const removed = (f: string) => remove.some((r) => f === r || f.startsWith(r + '/'));
  const renamed = remote.map((f) => renames.reduce((acc, [from, to]) => replaceFolderPrefix(acc, from, to) ?? acc, f)).filter(Boolean);
  const out = new Set(renamed.filter((f) => !removed(f)));
  for (const a of add) if (!removed(a)) out.add(a);
  return [...out].sort();
}

function parseFoldersJson(text: string): string[] {
  try {
    const j = JSON.parse(text);
    return Array.isArray(j?.folders) ? j.folders.filter((x: unknown) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function foldersJson(folders: string[]): string {
  return JSON.stringify({ version: 1, folders }, null, 2) + '\n';
}

/**
 * 同期エンジン。ネットワークに触れるのはここだけで、UI は IndexedDB の内容を読み書きするだけ。
 * ローカルが正、GitHub はバックエンドのオフラインファースト。
 */
export class SyncEngine {
  private listeners = new Set<Listener>();
  private flushing: Promise<void> | null = null;
  private timer: unknown = null;
  private index: NotesIndex = EMPTY_INDEX;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (h: unknown) => void;
  /** 手動モードで commitNow() の実行中だけキューを流す */
  private manualRun = false;

  state: EngineState = {
    online: true,
    configured: false,
    syncing: false,
    inflight: [],
    pending: 0,
    mode: 'auto',
    changes: 0,
    paused: null,
    indexMissing: false,
    version: 0,
  };

  constructor(
    readonly store: Store,
    readonly queue: Queue,
    private client: GitHubClient | null,
    opts: EngineOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.state.configured = !!client;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<EngineState> = {}) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private bump() {
    this.emit({ version: this.state.version + 1 });
  }

  setClient(client: GitHubClient | null) {
    this.client = client;
    this.emit({ configured: !!client, paused: null });
  }

  getClient() {
    return this.client;
  }

  private get auto() {
    return this.state.mode === 'auto';
  }

  /** 手動 → 自動に切り替えた時は、溜まっている変更を 1 コミットで送る */
  async setMode(mode: SyncMode): Promise<void> {
    const prev = this.state.mode;
    this.emit({ mode });
    if (prev === 'manual' && mode === 'auto' && this.state.changes > 0) {
      await this.queue.enqueue({ op: 'sync', ids: [] }, this.now());
      await this.afterLocalChange();
    }
  }

  /** 未コミットの変更をまとめて 1 コミットにする（手動モードの「同期」ボタン） */
  async commitNow(): Promise<void> {
    if (!this.client) return;
    await this.queue.enqueue({ op: 'sync', ids: [] }, this.now());
    await this.queue.wakeAll(this.now());
    if (this.state.paused?.reason !== 'ratelimit') this.emit({ paused: null });
    this.manualRun = true;
    try {
      // 実行中の flush があればそれを待ってから、積んだ sync を流す
      await this.flush();
      await this.flush();
    } finally {
      this.manualRun = false;
    }
  }

  setOnline(online: boolean) {
    const was = this.state.online;
    this.emit({ online });
    if (online && !was) void this.sync();
  }

  // ---------------------------------------------------------------- 起動・index

  /** キャッシュ済みの index とノートを読み、即座に描画できる状態にする */
  async loadCache(): Promise<void> {
    const rec = await this.store.getIndex();
    if (rec) this.index = rec.data;
    this.emit({ pending: await this.queue.count(), changes: await this.countChanges(), lastIndexAt: rec?.fetchedAt });
    this.bump();
  }

  private async countChanges(): Promise<number> {
    const notes = (await this.store.allNotes()).filter((r) => (r.dirty && !r.deleted) || r.purge).length;
    const atts = (await this.store.allAttachments()).filter((a) => a.dirty).length;
    return notes + atts + ((await this.store.getFolders())?.dirty ? 1 : 0);
  }

  /** 起動時・フォアグラウンド復帰時・5 分おきに呼ぶ */
  async sync(): Promise<void> {
    if (!this.client || !this.state.online) return;
    await this.queue.wakeAll(this.now());
    try {
      await this.refreshIndex();
    } catch (e) {
      this.handleError(e);
    }
    await this.flush();
  }

  async refreshIndex(): Promise<boolean> {
    if (!this.client) return false;
    const rec = await this.store.getIndex();
    let r;
    try {
      r = await this.client.getIndex(rec?.etag);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'notfound') {
        // index.json が無い。リポ自体が無い場合は接続テストで別途検出する
        this.emit({ indexMissing: true });
        return false;
      }
      throw e;
    }
    this.emit({ indexMissing: false, lastIndexAt: this.now() });
    if (!r) return false;
    let data: NotesIndex;
    try {
      data = JSON.parse(r.text);
    } catch {
      this.emit({ lastError: 'index.json の解析に失敗しました' });
      return false;
    }
    data.notes ??= [];
    data.folders ??= [];
    data.tags ??= {};
    this.index = data;
    await this.store.putIndex({ data, etag: r.etag, fetchedAt: this.now() });
    await this.gcAfterIndex();
    this.bump();
    return true;
  }

  /** index に反映されたローカルの一時状態を片付ける */
  private async gcAfterIndex() {
    const ids = new Set(this.index.notes.map((n) => n.id));
    for (const r of await this.store.allNotes()) {
      if (r.deleted && !ids.has(r.id)) await this.store.deleteNote(r.id);
    }
    const f = await this.store.getFolders();
    if (f && !f.dirty) {
      const idx = new Set(this.index.folders);
      const add = f.add.filter((a) => !idx.has(a));
      const remove = f.remove.filter((r) => idx.has(r));
      const renames = (f.renames ?? []).filter(([from]) => this.index.folders.some((x) => replaceFolderPrefix(x, from, '') !== null));
      await this.store.putFolders({ ...f, add, remove, renames });
    }
  }

  getIndex(): NotesIndex {
    return this.index;
  }

  /** index ノートの sha とローカル base の sha が違う＝リモートの方が新しい */
  async isStale(id: string): Promise<boolean> {
    const idx = this.index.notes.find((n) => n.id === id);
    if (!idx) return false;
    const base = await this.store.getBase(id);
    return !base || base.sha !== idx.sha;
  }

  // ---------------------------------------------------------------- ビュー

  /**
   * 「index の内容 + ローカルの未反映変更」を重ねたビュー。
   * ローカルの updated が index より新しければローカルのメタデータを優先し、
   * 削除済みのノートは index から消えるまで非表示にする。
   */
  async summaries(): Promise<NoteSummary[]> {
    const map = new Map<string, NoteSummary>();
    const idxById = new Map(this.index.notes.map((n) => [n.id, n]));
    for (const n of this.index.notes) map.set(n.id, summaryFromIndex(n));
    const bases = new Map((await this.store.allBases()).map((b) => [b.id, b]));
    const generatedAt = timeOf(this.index.generatedAt);
    for (const r of await this.store.allNotes()) {
      if (r.deleted) {
        map.delete(r.id);
        continue;
      }
      const idx = idxById.get(r.id);
      const base = bases.get(r.id);
      // index より後に自分が push した、または updated が新しい → index がまだ追いついていない
      const pushedAfterIndex = r.syncedAt != null && generatedAt > 0 && r.syncedAt >= generatedAt;
      const useLocal =
        !idx ||
        r.dirty ||
        !!r.conflict ||
        (base?.sha !== idx.sha && (pushedAfterIndex || timeOf(r.meta.updated) > timeOf(idx.updated)));
      if (useLocal) map.set(r.id, summaryFromRecord(r));
    }
    return [...map.values()];
  }

  /** folders.json の内容（index の folders ∪ ローカルの追加 − 削除） */
  async folderSet(): Promise<string[]> {
    const f = await this.store.getFolders();
    return applyFolderSet(this.index.folders, f?.add ?? [], f?.remove ?? [], f?.renames);
  }

  async noteStatus(id: string): Promise<NoteStatus> {
    const r = await this.store.getNote(id);
    if (r?.conflict) return 'conflict';
    if (!r?.dirty) return 'synced';
    if (this.state.inflight.includes(id)) return 'syncing';
    if (!this.state.online || !this.client) return 'offline';
    return 'local';
  }

  // ---------------------------------------------------------------- ノートの読み込み

  /** 開いた時に本文を取りに行く。オフラインならキャッシュを返す */
  async openNote(id: string): Promise<NoteRecord | undefined> {
    const rec = await this.store.getNote(id);
    if (rec?.deleted) return undefined;
    if (rec && (rec.dirty || rec.conflict)) return rec;
    if (rec && !(await this.isStale(id))) return rec;
    if (!this.client || !this.state.online) return rec;
    try {
      return await this.fetchNote(id);
    } catch (e) {
      this.handleError(e);
      return rec;
    }
  }

  async fetchNote(id: string): Promise<NoteRecord> {
    const f = await this.client!.getFile(notePath(id));
    const cur = await this.store.getNote(id);
    if (cur?.dirty) return cur; // 取得中に編集された
    const rec = recordFromContent(id, f.content, this.now(), false);
    await this.store.putBase({ id, content: f.content, sha: f.sha });
    await this.store.putNote(rec);
    return rec;
  }

  /** フォルダ・タグの一括変更に必要なノート本文を揃える */
  private async ensureLoaded(ids: string[]): Promise<void> {
    const need: string[] = [];
    for (const id of ids) {
      const r = await this.store.getNote(id);
      if (!r || (!r.dirty && (await this.isStale(id)))) need.push(id);
    }
    if (need.length && (!this.client || !this.state.online)) {
      throw new Error(`オフラインのため ${need.length} 件のノート本文を取得できません`);
    }
    const queue = [...need];
    await Promise.all(
      Array.from({ length: Math.min(5, queue.length) }, async () => {
        for (let id = queue.shift(); id; id = queue.shift()) await this.fetchNote(id);
      }),
    );
  }

  // ---------------------------------------------------------------- ローカル操作

  /**
   * 編集内容は IndexedDB に即時保存する。送信キューに積むのは編集停止から 3 秒後、
   * またはノートを閉じた時点（enqueue: true）で、キーストロークごとにはコミットしない。
   */
  async saveNote(id: string, content: string, opts: { enqueue?: boolean } = {}): Promise<void> {
    const enqueue = opts.enqueue ?? true;
    const cur = await this.store.getNote(id);
    let rec = cur;
    const changed = !(cur && cur.content === content && !cur.deleted);
    if (changed) {
      rec = recordFromContent(id, content, this.now(), true);
      if (cur?.conflict) rec.conflict = cur.conflict;
      await this.store.putNote(rec);
    }
    const queued = enqueue && this.auto && !!rec?.dirty && !rec.conflict;
    if (queued) await this.queue.enqueue({ op: 'put', ids: [id] }, this.now());
    if (changed || queued) await this.afterLocalChange(queued);
  }

  async createNote(
    opts: { folder?: string; tags?: string[]; title?: string; body?: string; extra?: Record<string, unknown> } = {},
  ): Promise<string> {
    const { id, content } = createNoteContent(opts);
    await this.saveNote(id, content);
    return id;
  }

  private async rewrite(id: string, fn: (content: string) => string): Promise<void> {
    const r = (await this.store.getNote(id)) ?? (await this.openNote(id));
    if (!r) throw new Error('ノートが見つかりません');
    await this.saveNote(id, fn(r.content));
  }

  async moveNote(id: string, folder: string): Promise<void> {
    const f = normalizeFolder(folder);
    await this.rewrite(id, (c) => updateMeta(c, { folder: f }, new Date(this.now())));
  }

  async setTags(id: string, tags: string[]): Promise<void> {
    await this.rewrite(id, (c) => updateMeta(c, { tags }, new Date(this.now())));
  }

  async trashNote(id: string): Promise<void> {
    await this.rewrite(id, (c) => moveToTrash(c, new Date(this.now())));
  }

  async restoreNote(id: string): Promise<void> {
    await this.rewrite(id, (c) => {
      const restored = restoreFromTrash(c, new Date(this.now()));
      // 元のフォルダ名が今は使えない場合はルートへ
      try {
        normalizeFolder(parseNote(restored).meta.folder);
        return restored;
      } catch {
        return updateMeta(restored, { folder: '' });
      }
    });
  }

  /** 完全削除（本文 + 添付を一括コミットで消す）。ゴミ箱ビューからの明示操作のみ */
  async purgeNotes(ids: string[]): Promise<void> {
    if (!ids.length) return;
    for (const id of ids) {
      const r = await this.store.getNote(id);
      await this.store.putNote({
        ...(r ?? recordFromContent(id, '', this.now(), false)),
        deleted: true,
        purge: true,
        dirty: false,
        conflict: undefined,
      });
    }
    if (this.auto) await this.queue.enqueue({ op: 'delete', ids }, this.now());
    await this.afterLocalChange();
  }

  /** trashedAt から days 日経過したゴミ箱のノート */
  async expiredTrash(days = 30): Promise<string[]> {
    const limit = this.now() - days * 86400_000;
    return (await this.summaries()).filter((n) => isTrashed(n) && n.trashedAt && timeOf(n.trashedAt) <= limit).map((n) => n.id);
  }

  async createFolder(path: string): Promise<void> {
    const p = normalizeFolder(path);
    if (!p) return;
    const notes = await this.summaries();
    if (notes.some((n) => n.folder === p || n.folder.startsWith(p + '/'))) return; // 既にノートがある
    const f = await this.foldersRecord();
    await this.store.putFolders({
      ...f,
      add: [...new Set([...f.add, p])],
      remove: f.remove.filter((r) => !expandPaths(p).includes(r)),
      dirty: true,
    });
    if (this.auto) await this.queue.enqueue({ op: 'folders', ids: [] }, this.now());
    await this.afterLocalChange();
  }

  /** 空のフォルダだけ削除できる */
  async deleteFolder(path: string): Promise<void> {
    const notes = await this.summaries();
    if (notes.some((n) => !isTrashed(n) && (n.folder === path || n.folder.startsWith(path + '/')))) {
      throw new Error('ノートが入っているフォルダは削除できません。先にノートを移動してください');
    }
    const f = await this.foldersRecord();
    await this.store.putFolders({
      ...f,
      add: f.add.filter((a) => a !== path && !a.startsWith(path + '/')),
      remove: [...new Set([...f.remove, path])],
      dirty: true,
    });
    if (this.auto) await this.queue.enqueue({ op: 'folders', ids: [] }, this.now());
    await this.afterLocalChange();
  }

  private async foldersRecord(): Promise<FoldersRecord> {
    return (await this.store.getFolders()) ?? { add: [], remove: [], dirty: false };
  }

  /** フォルダのリネーム・移動の対象ノート */
  async notesUnderFolder(path: string): Promise<string[]> {
    return (await this.summaries()).filter((n) => replaceFolderPrefix(n.folder, path, '') !== null).map((n) => n.id);
  }

  async renameFolder(from: string, to: string): Promise<number> {
    const src = normalizeFolder(from);
    const dst = normalizeFolder(to);
    if (!src || src === dst) return 0;
    if (dst.startsWith(src + '/')) throw new Error('フォルダを自分の配下には移動できません');
    const ids = await this.notesUnderFolder(src);
    await this.ensureLoaded(ids);
    for (const id of ids) {
      const r = (await this.store.getNote(id))!;
      const nf = replaceFolderPrefix(r.meta.folder ?? '', src, dst);
      if (nf === null) continue;
      await this.writeLocal(id, updateMeta(r.content, { folder: nf }, new Date(this.now())));
    }
    const f = await this.foldersRecord();
    await this.store.putFolders({
      add: f.add.map((a) => replaceFolderPrefix(a, src, dst) ?? a).filter(Boolean),
      remove: f.remove,
      renames: [...(f.renames ?? []), [src, dst]],
      dirty: true,
    });
    if (this.auto) {
      await this.queue.enqueue({ op: 'batch', ids, message: `folder: リネーム ${src} → ${dst || '(ルート)'}`, folders: true }, this.now());
    }
    await this.afterLocalChange();
    return ids.length;
  }

  async notesWithTag(tag: string): Promise<string[]> {
    return (await this.summaries()).filter((n) => n.tags.includes(tag)).map((n) => n.id);
  }

  /** タグのリネーム・統合。既に to があれば重複除去される */
  async renameTag(from: string, to: string): Promise<number> {
    const src = normalizeTag(from);
    const dst = normalizeTag(to);
    if (!src || !dst || src === dst) return 0;
    const ids = await this.notesWithTag(src);
    await this.ensureLoaded(ids);
    for (const id of ids) {
      const r = (await this.store.getNote(id))!;
      const tags = [...new Set((r.meta.tags ?? []).map((t) => (t === src ? dst : t)))];
      await this.writeLocal(id, updateMeta(r.content, { tags }, new Date(this.now())));
    }
    if (this.auto) await this.queue.enqueue({ op: 'batch', ids, message: `tag: リネーム ${src} → ${dst}` }, this.now());
    await this.afterLocalChange();
    return ids.length;
  }

  /** キューに積まずにローカルだけ書き換える（一括コミット用） */
  private async writeLocal(id: string, content: string) {
    const cur = await this.store.getNote(id);
    const rec = recordFromContent(id, content, this.now(), true);
    if (cur?.conflict) rec.conflict = cur.conflict;
    await this.store.putNote(rec);
  }

  /** 画像を attachments/<id>/ に保存し、本文に挿入する相対パスを返す */
  async addAttachment(noteId: string, filename: string, blob: Blob): Promise<string> {
    const safe = filename.normalize('NFC').replace(/[\\/:*?"<>|`\s]+/g, '-') || 'file';
    const name = `${this.now().toString(36)}-${safe}`;
    const key = `${noteId}/${name}`;
    await this.store.putAttachment({ key, noteId, filename: name, blob, dirty: true });
    if (this.auto) await this.queue.enqueue({ op: 'attach', ids: [noteId], key }, this.now());
    await this.afterLocalChange();
    return `../attachments/${noteId}/${encodeURIComponent(name)}`;
  }

  /** 添付の表示用 Blob。IndexedDB に無ければ取得してキャッシュする */
  async loadAttachment(noteId: string, filename: string): Promise<Blob | undefined> {
    const key = `${noteId}/${filename}`;
    const hit = await this.store.getAttachment(key);
    if (hit) return hit.blob;
    if (!this.client || !this.state.online) return undefined;
    const { bytes } = await this.client.getBinary(`attachments/${key}`);
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const mime =
      { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] ??
      'application/octet-stream';
    const blob = new Blob([bytes as BlobPart], { type: mime });
    await this.store.putAttachment({ key, noteId, filename, blob, dirty: false });
    return blob;
  }

  /** 競合の解決 */
  async resolveConflict(id: string, choice: 'local' | 'remote' | 'copy'): Promise<string | undefined> {
    const r = await this.store.getNote(id);
    if (!r?.conflict) return;
    const remote = r.conflict;
    let copyId: string | undefined;
    if (choice === 'local') {
      // リモート版を base にして、ローカル版で上書きする
      await this.store.putBase({ id, content: remote.content, sha: remote.sha });
      await this.store.putNote({ ...r, conflict: undefined, dirty: true });
      if (this.auto) await this.queue.enqueue({ op: 'put', ids: [id] }, this.now());
    } else {
      if (choice === 'copy') {
        const { meta, body } = parseNote(r.content, id);
        copyId = await this.createNote({
          folder: isTrashed(meta) ? '' : meta.folder,
          tags: meta.tags,
          title: `${displayTitle(meta, body)}（ローカル版）`,
          body,
        });
      }
      await this.store.putBase({ id, content: remote.content, sha: remote.sha });
      await this.store.putNote({ ...recordFromContent(id, remote.content, this.now(), false) });
    }
    await this.afterLocalChange();
    return copyId;
  }

  private async afterLocalChange(flush = true) {
    this.emit({ pending: await this.queue.count(), changes: await this.countChanges() });
    this.bump();
    if (flush && this.client && this.state.online && !this.state.paused) void this.flush();
  }

  // ---------------------------------------------------------------- 送信キュー

  /** キューを先頭から流す。実行中なら完了を待つ */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.runQueue().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private schedule(at: number) {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        if (this.state.paused?.reason === 'ratelimit') this.emit({ paused: null });
        void this.flush();
      },
      Math.max(0, at - this.now()),
    );
  }

  private async runQueue(): Promise<void> {
    if (!this.client || !this.state.online) return;
    if (!this.auto && !this.manualRun) return;
    const p = this.state.paused;
    if (p) {
      if (p.reason === 'ratelimit' && p.until && p.until <= this.now()) this.emit({ paused: null });
      else return;
    }
    this.emit({ syncing: true });
    try {
      for (let item = await this.queue.peek(); item; item = await this.queue.peek()) {
        if (item.nextAt > this.now()) {
          this.schedule(item.nextAt);
          break;
        }
        this.emit({ inflight: item.ids });
        try {
          await this.process(item);
          await this.queue.remove(item.seq!);
          this.emit({ lastError: undefined });
        } catch (e) {
          if (e instanceof ConflictPending) {
            await this.queue.remove(item.seq!);
            continue;
          }
          const stop = await this.onProcessError(item, e);
          if (stop) break;
        } finally {
          this.emit({ inflight: [], pending: await this.queue.count() });
          this.bump();
        }
      }
    } finally {
      this.emit({ syncing: false, pending: await this.queue.count(), changes: await this.countChanges() });
    }
  }

  private handleError(e: unknown) {
    if (!(e instanceof GitHubError)) {
      this.emit({ lastError: String((e as Error)?.message ?? e) });
      return;
    }
    switch (e.kind) {
      case 'auth':
        this.emit({ paused: { reason: 'auth', message: 'トークンが無効です。設定画面で再設定してください' }, lastError: e.message });
        break;
      case 'ratelimit':
        this.emit({ paused: { reason: 'ratelimit', message: 'API のレート制限中です', until: e.resetAt }, lastError: e.message });
        if (e.resetAt) this.schedule(e.resetAt);
        break;
      case 'forbidden':
        this.emit({ paused: { reason: 'forbidden', message: '対象リポジトリへの権限がありません。トークンを再発行してください' }, lastError: e.message });
        break;
      case 'network':
        this.emit({ lastError: e.message });
        break;
      default:
        this.emit({ lastError: e.message });
    }
  }

  /** 戻り値 true でキュー処理を止める */
  private async onProcessError(item: QueueItem, e: unknown): Promise<boolean> {
    this.handleError(e);
    const msg = String((e as Error)?.message ?? e);
    if (e instanceof GitHubError) {
      if (e.kind === 'auth' || e.kind === 'forbidden') return true; // 項目は残してキューを止める
      if (e.kind === 'ratelimit') {
        await this.queue.fail(item, msg, this.now(), e.resetAt);
        return true;
      }
      if (e.kind === 'notfound' && item.op !== 'delete') {
        this.emit({ paused: { reason: 'notfound', message: 'リポジトリが見つかりません。設定画面でリポ名を確認してください' } });
        return true;
      }
    }
    // ネットワークエラー・5xx・その他は指数バックオフで再試行
    const next = await this.queue.fail(item, msg, this.now());
    this.schedule(next.nextAt);
    return true;
  }

  private async process(item: QueueItem): Promise<void> {
    switch (item.op) {
      case 'put':
        return this.processPut(item.ids[0]);
      case 'delete':
        return this.processDelete(item.ids);
      case 'batch':
        return this.processBatch(item.ids, item.message, { folders: !!item.folders });
      case 'folders':
        return this.processFolders();
      case 'attach':
        return this.processAttach(item.key);
      case 'sync':
        return this.processSync();
    }
  }

  private commitMessage(content: string, baseContent: string | undefined, id: string): string {
    let meta, body;
    try {
      ({ meta, body } = parseNote(content, id));
    } catch {
      return `note: 更新 ${id}`;
    }
    const title = displayTitle(meta, body);
    if (baseContent === undefined) return `note: 作成 ${title}`;
    let before = '';
    try {
      before = parseNote(baseContent, id).meta.folder ?? '';
    } catch {
      /* noop */
    }
    const folder = meta.folder ?? '';
    if (folder !== before) {
      if (isTrashed(meta)) return `note: ゴミ箱へ ${title}`;
      return `note: 移動 ${title} → ${folder || '(ルート)'}`;
    }
    return `note: 更新 ${title}`;
  }

  private async processPut(id: string): Promise<void> {
    const client = this.client!;
    for (let attempt = 0; attempt < 3; attempt++) {
      const note = await this.store.getNote(id);
      if (!note || note.deleted || !note.dirty) return;
      if (note.conflict) return;
      const base = await this.store.getBase(id);
      const sent = note.content;
      try {
        const r = await client.putFile(notePath(id), sent, this.commitMessage(sent, base?.content, id), base?.sha);
        await this.afterPut(id, sent, r.sha);
        return;
      } catch (e) {
        const mismatch =
          e instanceof GitHubError && (e.kind === 'conflict' || (e.kind === 'unprocessable' && !base) || (e.kind === 'notfound' && !!base));
        if (!mismatch) throw e;
      }
      // sha 不一致: リモート版を取って 3-way マージ
      let remote;
      try {
        remote = await client.getFile(notePath(id));
      } catch (e) {
        if (e instanceof GitHubError && e.kind === 'notfound') {
          // リモートで削除されていた。新規として作り直す
          await this.store.deleteBase(id);
          continue;
        }
        throw e;
      }
      const latest = (await this.store.getNote(id))!;
      const merged = mergeNote(base?.content ?? null, latest.content, remote.content);
      if (!merged.ok) {
        await this.store.putNote({ ...latest, conflict: { content: remote.content, sha: remote.sha } });
        throw new ConflictPending();
      }
      await this.store.putBase({ id, content: remote.content, sha: remote.sha });
      if (merged.content === remote.content) {
        await this.store.putNote({ ...recordFromContent(id, remote.content, this.now(), false) });
        return;
      }
      await this.store.putNote({ ...recordFromContent(id, merged.content, this.now(), true) });
      // 次のループでマージ結果を remote の sha に対して PUT する
    }
    throw new GitHubError('競合の解決を繰り返し失敗しました', 409, 'conflict');
  }

  private async afterPut(id: string, sent: string, sha: string) {
    await this.store.putBase({ id, content: sent, sha });
    const now = await this.store.getNote(id);
    if (!now || now.deleted) return;
    if (now.content === sent) {
      await this.store.putNote({ ...now, dirty: false, syncedAt: this.now() });
    } else {
      // 送信中に編集された
      await this.store.putNote({ ...now, syncedAt: this.now() });
      if (this.auto) await this.queue.enqueue({ op: 'put', ids: [id] }, this.now());
    }
  }

  private async processDelete(ids: string[]): Promise<void> {
    await this.processBatch([], null, { purges: ids });
  }

  /** 未コミットの変更をすべて集めて 1 コミットにする */
  private async processSync(): Promise<void> {
    const notes = await this.store.allNotes();
    const purges = notes.filter((n) => n.purge).map((n) => n.id);
    const ids = notes.filter((n) => n.dirty && !n.deleted && !n.conflict).map((n) => n.id);
    const attachments = (await this.store.allAttachments()).filter((a) => a.dirty && !purges.includes(a.noteId)).map((a) => a.key);
    await this.processBatch(ids, null, { folders: true, attachments, purges });
  }

  /**
   * 一括コミット。ファイルごとの楽観ロックが効かないので、head のツリーで base の sha と
   * 一致するかを確かめ、食い違ったノートは外して通常の put（マージ経路）に回す。
   * message が null なら変更内容から作る（1 件ならその件のメッセージ、複数なら一覧）。
   */
  private async processBatch(
    ids: string[],
    message: string | null,
    opts: { folders?: boolean; attachments?: string[]; purges?: string[] } = {},
  ): Promise<void> {
    const sent = new Map<string, string>();
    const diverged: string[] = [];
    const lines: string[] = [];
    let foldersSent: FoldersRecord | null = null;
    const purges = opts.purges ?? [];
    const attachments = opts.attachments ?? [];

    const r = await this.client!.commitBatch(
      () => message ?? (lines.length === 1 ? lines[0] : `sync: ${lines.length} 件の変更\n\n${lines.map((l) => `- ${l}`).join('\n')}`),
      async (tree) => {
        sent.clear();
        diverged.length = 0;
        lines.length = 0;
        foldersSent = null;
        const changes: TreeChange[] = [];
        for (const id of ids) {
          const note = await this.store.getNote(id);
          if (!note || note.deleted || !note.dirty || note.conflict) continue;
          const base = await this.store.getBase(id);
          const remoteSha = tree.get(notePath(id));
          if ((base?.sha ?? undefined) !== remoteSha) {
            diverged.push(id);
            continue;
          }
          sent.set(id, note.content);
          changes.push({ path: notePath(id), content: note.content });
          lines.push(this.commitMessage(note.content, base?.content, id));
        }
        for (const id of purges) {
          const paths = [...tree.keys()].filter((p) => p === notePath(id) || p.startsWith(`attachments/${id}/`));
          for (const p of paths) changes.push({ path: p, content: null });
          if (paths.length) lines.push(`note: 削除 ${this.index.notes.find((n) => n.id === id)?.title || id}`);
        }
        for (const key of attachments) {
          const a = await this.store.getAttachment(key);
          if (!a?.dirty) continue;
          const b64 = bytesToBase64(new Uint8Array(await a.blob.arrayBuffer()));
          changes.push({ path: `attachments/${key}`, content: b64, base64: true });
          lines.push(`note: 添付 ${a.filename}`);
        }
        if (opts.folders) {
          const f = await this.foldersRecord();
          if (f.dirty) {
            const sha = tree.get(FOLDERS_PATH);
            const remote = sha ? parseFoldersJson(new TextDecoder().decode(await this.client!.getBlob(sha))) : [];
            const next = applyFolderSet(remote, f.add, f.remove, f.renames);
            if (JSON.stringify(next) !== JSON.stringify([...remote].sort())) {
              changes.push({ path: FOLDERS_PATH, content: foldersJson(next) });
              lines.push('meta: フォルダ一覧を更新');
            }
          }
          foldersSent = f;
        }
        return changes;
      },
    );

    for (const [id, content] of sent) {
      const sha = r.shas.get(notePath(id));
      if (sha) await this.afterPut(id, content, sha);
    }
    for (const key of attachments) {
      const a = await this.store.getAttachment(key);
      if (a) await this.store.putAttachment({ ...a, dirty: false });
    }
    for (const id of purges) {
      await this.store.deleteBase(id);
      for (const a of await this.store.attachmentsOf(id)) await this.store.deleteAttachment(a.key);
      const rec = await this.store.getNote(id);
      if (rec) await this.store.putNote({ ...rec, content: '', deleted: true, purge: false, dirty: false });
    }
    // 食い違ったノートは同じ実行の中で put（マージ経路）に回す
    for (const id of diverged) await this.queue.enqueue({ op: 'put', ids: [id] }, this.now());
    if (foldersSent) await this.markFoldersSynced(foldersSent);
  }

  private async markFoldersSynced(sent: FoldersRecord) {
    const f = await this.foldersRecord();
    const key = (x: FoldersRecord) => JSON.stringify([x.add, x.remove, x.renames ?? []]);
    await this.store.putFolders({ ...f, dirty: key(f) !== key(sent) });
  }

  /** _meta/folders.json は集合として扱い、競合時は和集合で解決する（マージ画面なし） */
  private async processFolders(): Promise<void> {
    const client = this.client!;
    for (let attempt = 0; attempt < 3; attempt++) {
      const f = await this.foldersRecord();
      if (!f.dirty) return;
      let remote: string[] = [];
      let sha: string | undefined;
      try {
        const file = await client.getFile(FOLDERS_PATH);
        remote = parseFoldersJson(file.content);
        sha = file.sha;
      } catch (e) {
        if (!(e instanceof GitHubError && e.kind === 'notfound')) throw e;
      }
      const next = applyFolderSet(remote, f.add, f.remove, f.renames);
      if (JSON.stringify(next) !== JSON.stringify([...remote].sort())) {
        try {
          await client.putFile(FOLDERS_PATH, foldersJson(next), 'meta: フォルダ一覧を更新', sha);
        } catch (e) {
          if (e instanceof GitHubError && (e.kind === 'conflict' || e.kind === 'unprocessable')) continue;
          throw e;
        }
      }
      await this.markFoldersSynced(f);
      return;
    }
    throw new GitHubError('folders.json の更新が競合し続けました', 409, 'conflict');
  }

  private async processAttach(key: string): Promise<void> {
    const a = await this.store.getAttachment(key);
    if (!a || !a.dirty) return;
    const note = await this.store.getNote(a.noteId);
    if (note?.deleted) return;
    const b64 = bytesToBase64(new Uint8Array(await a.blob.arrayBuffer()));
    const path = `attachments/${key}`;
    try {
      await this.client!.putFile(path, b64, `note: 添付 ${a.filename}`, undefined, true);
    } catch (e) {
      if (!(e instanceof GitHubError && e.kind === 'unprocessable')) throw e;
      // 既に同名がある（前回の送信が途中で切れた等）。上書きする
      const existing = (await this.client!.listDir(`attachments/${a.noteId}`)).find((x) => x.path === path);
      await this.client!.putFile(path, b64, `note: 添付 ${a.filename}`, existing?.sha, true);
    }
    await this.store.putAttachment({ ...a, dirty: false });
  }

  // ---------------------------------------------------------------- 履歴

  async history(id: string) {
    if (!this.client) throw new Error('未設定です');
    return this.client.listCommits(notePath(id));
  }

  async versionAt(id: string, sha: string): Promise<string> {
    if (!this.client) throw new Error('未設定です');
    return (await this.client.getFile(notePath(id), sha)).content;
  }

  /** ゴミ箱を含む trash 判定（UI 用の再エクスポート） */
  static readonly TRASH = TRASH;
}
