import { isTrashed, parseNote } from './domain/note';
import { SearchIndex } from './domain/search';
import { buildTree, tagCounts, type FolderNode } from './domain/tree';
import type { NoteSummary } from './domain/types';
import { decryptToken, decryptWithKey, encryptToken, type EncryptedToken } from './platform/crypto';
import { openDb, Store } from './store/db';
import { Queue } from './store/queue';
import { GitHubClient, type RepoRef } from './sync/github';
import { SyncEngine, type EngineState, type SyncMode } from './sync/sync';

export interface Config extends RepoRef {
  /** トークンの有効期限（ISO 日付）。ヘッダから取れればそれを、取れなければ手入力 */
  tokenExpiry?: string;
  /** 未設定は auto */
  syncMode?: SyncMode;
}

export type Phase = 'loading' | 'setup' | 'locked' | 'ready';

const REFRESH_MS = 5 * 60_000;
const EXPIRY_WARN_DAYS = 14;

class AppState {
  phase = $state<Phase>('loading');
  config = $state<Config | null>(null);
  engine!: SyncEngine;
  store!: Store;
  sync = $state<EngineState | null>(null);
  notes = $state<NoteSummary[]>([]);
  folderSet = $state<string[]>([]);
  /** ロックを解除せずオフラインで閲覧中 */
  readOnlyOffline = $state(false);
  toast = $state<string | null>(null);
  /** 最後に開いたノート（スマホのスワイプで戻る先） */
  lastNote = $state<string | null>(null);
  updateAvailable = $state(false);
  applyUpdate: (() => void) | null = null;

  private search = new SearchIndex();
  private searchSeeded = false;
  private bodies = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  tree = $derived<FolderNode>(buildTree(this.folderSet, this.notes));
  tags = $derived<[string, number][]>(tagCounts(this.notes));
  trashCount = $derived(this.notes.filter((n) => isTrashed(n)).length);
  byId = $derived(new Map(this.notes.map((n) => [n.id, n])));
  /** 未同期の件数（起動時に目立たせる） */
  unsynced = $derived(this.sync?.changes ?? 0);
  manual = $derived(this.sync?.mode === 'manual');

  expiryWarning = $derived.by(() => {
    const e = this.config?.tokenExpiry;
    if (!e) return null;
    const days = Math.floor((Date.parse(e) - Date.now()) / 86400_000);
    return Number.isNaN(days) || days > EXPIRY_WARN_DAYS ? null : days;
  });

  async init() {
    this.store = new Store(await openDb());
    this.engine = new SyncEngine(this.store, new Queue(this.store.db), null);
    this.engine.setOnline(navigator.onLine);
    let lastVersion = -1;
    this.engine.subscribe((s) => {
      this.sync = s;
      if (s.version !== lastVersion) {
        lastVersion = s.version;
        void this.refreshView();
      }
    });
    addEventListener('online', () => this.engine.setOnline(true));
    addEventListener('offline', () => this.engine.setOnline(false));
    // Background Sync は iOS Safari 非対応なので、フォアグラウンド復帰時にキューを流す
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.engine.sync();
    });
    await this.engine.loadCache();

    this.config = (await this.store.getSetting<Config>('config')) ?? null;
    await this.engine.setMode(this.config?.syncMode ?? 'auto');
    const enc = await this.store.getSetting<EncryptedToken>('token');
    if (!this.config || !enc) {
      this.phase = 'setup';
      return;
    }
    const remembered = await this.store.getSetting<CryptoKey>('rememberedKey');
    if (remembered) {
      try {
        this.connect(await decryptWithKey(enc, remembered));
        return;
      } catch {
        await this.store.deleteSetting('rememberedKey');
      }
    }
    this.phase = 'locked';
  }

  async unlock(passphrase: string, remember: boolean) {
    const enc = await this.store.getSetting<EncryptedToken>('token');
    if (!enc) throw new Error('トークンが保存されていません');
    const { token, key } = await decryptToken(enc, passphrase);
    if (remember) await this.store.setSetting('rememberedKey', key);
    this.connect(token);
  }

  /** ロックを解除せず、キャッシュだけで閲覧する */
  browseOffline() {
    this.readOnlyOffline = true;
    this.phase = 'ready';
  }

  private connect(token: string) {
    const c = this.config!;
    const client = new GitHubClient(token, { owner: c.owner, repo: c.repo, branch: c.branch });
    this.engine.setClient(client);
    this.readOnlyOffline = false;
    this.phase = 'ready';
    void this.engine.sync().then(() => this.checkExpiry(client));
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.engine.sync(), REFRESH_MS);
  }

  private async checkExpiry(client: GitHubClient) {
    const exp = await client.fetchTokenExpiration();
    if (!exp || !this.config) return;
    const iso = new Date(exp.replace(' UTC', 'Z').replace(' ', 'T')).toISOString().slice(0, 10);
    if (Number.isNaN(Date.parse(iso)) || iso === this.config.tokenExpiry) return;
    await this.saveConfig({ ...this.config, tokenExpiry: iso });
  }

  async setSyncMode(mode: SyncMode) {
    if (this.config) await this.saveConfig({ ...this.config, syncMode: mode });
    await this.engine.setMode(mode);
  }

  /** 手動モードなら未コミットの変更を 1 コミットに、自動モードなら pull とキューの再開 */
  async syncNow() {
    if (!this.manual) return this.engine.sync();
    const n = this.unsynced;
    await this.engine.refreshIndex().catch(() => undefined);
    await this.engine.commitNow();
    const s = this.engine.state;
    if (s.paused || s.lastError) this.notify(`同期できませんでした: ${s.paused?.message ?? s.lastError}`);
    else if (n) this.notify(`${n} 件の変更をコミットしました`);
    else this.notify('最新の状態です');
  }

  async saveConfig(c: Config) {
    this.config = c;
    await this.store.setSetting('config', $state.snapshot(c));
  }

  /** 設定画面から: トークンを暗号化して保存し接続する */
  async saveCredentials(c: Config, token: string, passphrase: string, remember: boolean) {
    const { enc, key } = await encryptToken(token, passphrase);
    await this.store.setSetting('token', enc);
    if (remember) await this.store.setSetting('rememberedKey', key);
    else await this.store.deleteSetting('rememberedKey');
    const prev = this.config;
    await this.saveConfig(c);
    if (prev && (prev.owner !== c.owner || prev.repo !== c.repo || prev.branch !== c.branch)) {
      // 別のリポジトリに切り替えたらキャッシュは使えない
      await this.store.clearAll(true);
      await this.engine.loadCache();
    }
    this.connect(token);
  }

  async logout(clearData: boolean) {
    await this.store.deleteSetting('token');
    await this.store.deleteSetting('rememberedKey');
    if (clearData) {
      await this.store.clearAll(false);
      this.config = null;
    }
    this.engine.setClient(null);
    if (this.timer) clearInterval(this.timer);
    await this.engine.loadCache();
    this.phase = 'setup';
  }

  async refreshView() {
    this.notes = await this.engine.summaries();
    this.folderSet = await this.engine.folderSet();
    this.reindex();
  }

  // ------------------------------------------------------------ 検索

  /** 初期インデックスは title + excerpt、本文を取得済みのノートは本文で差し替える */
  private reindex() {
    const live = new Set(this.notes.map((n) => n.id));
    for (const id of this.search.ids()) if (!live.has(id)) this.search.remove(id);
    for (const id of this.bodies.keys()) if (!live.has(id)) this.bodies.delete(id);
    for (const n of this.notes) {
      this.search.upsert({ id: n.id, title: n.title, text: this.bodies.get(n.id) ?? n.excerpt });
    }
    if (!this.searchSeeded) {
      this.searchSeeded = true;
      void this.seedBodies();
    }
  }

  private async seedBodies() {
    for (const r of await this.store.allNotes()) {
      if (r.deleted) continue;
      this.indexBody(r.id, r.content);
    }
  }

  indexBody(id: string, content: string) {
    let body = content;
    try {
      body = parseNote(content, id).body;
    } catch {
      /* 生テキストのまま */
    }
    this.bodies.set(id, body);
    const s = this.byId.get(id);
    if (s) this.search.upsert({ id, title: s.title, text: body });
  }

  searchIds(q: string): string[] {
    return this.search.search(q).map((r) => r.id);
  }

  notify(msg: string) {
    this.toast = msg;
    setTimeout(() => {
      if (this.toast === msg) this.toast = null;
    }, 4000);
  }
}

export const app = new AppState();
