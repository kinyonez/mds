/** GitHub REST API クライアント。Contents API と Git Data API だけを使う */

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ErrorKind = 'network' | 'server' | 'auth' | 'forbidden' | 'ratelimit' | 'notfound' | 'conflict' | 'unprocessable' | 'other';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: ErrorKind,
    /** レート制限の解除時刻（ms） */
    readonly resetAt?: number,
  ) {
    super(message);
  }
}

export interface FileContent {
  content: string;
  sha: string;
}

export interface TreeChange {
  path: string;
  /** null は削除 */
  content: string | null;
  /** content が base64 のバイナリ */
  base64?: boolean;
}

export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
}

const API = 'https://api.github.com';

export function encodeBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  return bytesToBase64(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeBase64Utf8(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

function encPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export class GitHubClient {
  /** 直近のレスポンスで得たトークン有効期限（ヘッダが公開されていれば） */
  tokenExpiration?: string;

  constructor(
    private token: string,
    readonly ref: RepoRef,
    private fetchImpl: FetchLike = (i, init) => fetch(i, init),
  ) {}

  private get base() {
    return `${API}/repos/${encodeURIComponent(this.ref.owner)}/${encodeURIComponent(this.ref.repo)}`;
  }

  private async request(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('Accept', init.accept ?? 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    if (init.body) headers.set('Content-Type', 'application/json');
    let res: Response;
    try {
      res = await this.fetchImpl(path.startsWith('http') ? path : this.base + path, { ...init, headers, cache: 'no-store' });
    } catch (e) {
      throw new GitHubError(`ネットワークエラー: ${(e as Error).message}`, 0, 'network');
    }
    const exp = res.headers.get('github-authentication-token-expiration');
    if (exp) this.tokenExpiration = exp;
    if (res.ok || res.status === 304) return res;
    throw await this.toError(res);
  }

  private async toError(res: Response): Promise<GitHubError> {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.message) msg = `${res.status} ${j.message}`;
    } catch {
      /* 本文なし */
    }
    const s = res.status;
    if (s === 401) return new GitHubError(msg, s, 'auth');
    if ((s === 403 || s === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || s === 429)) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const retry = Number(res.headers.get('retry-after'));
      const resetAt = reset ? reset * 1000 : retry ? Date.now() + retry * 1000 : Date.now() + 60_000;
      return new GitHubError(msg, s, 'ratelimit', resetAt);
    }
    if (s === 403) return new GitHubError(msg, s, 'forbidden');
    if (s === 404) return new GitHubError(msg, s, 'notfound');
    if (s === 409) return new GitHubError(msg, s, 'conflict');
    if (s === 422) return new GitHubError(msg, s, 'unprocessable');
    if (s >= 500) return new GitHubError(msg, s, 'server');
    return new GitHubError(msg, s, 'other');
  }

  /** 接続テスト。push 権限の有無を返す */
  async getRepo(): Promise<{ private: boolean; push: boolean; defaultBranch: string }> {
    const j = await (await this.request('')).json();
    return { private: !!j.private, push: !!j.permissions?.push, defaultBranch: j.default_branch };
  }

  /** index.json を ETag で条件付き取得。304 なら null */
  async getIndex(etag?: string): Promise<{ text: string; etag?: string } | null> {
    const headers: Record<string, string> = {};
    if (etag) headers['If-None-Match'] = etag;
    const res = await this.request(`/contents/index.json?ref=${encodeURIComponent(this.ref.branch)}`, {
      accept: 'application/vnd.github.raw+json',
      headers,
    });
    if (res.status === 304) return null;
    return { text: await res.text(), etag: res.headers.get('etag') ?? undefined };
  }

  /** テキストファイルの取得。1 MB 超は blob API にフォールバック */
  async getFile(path: string, ref?: string): Promise<FileContent> {
    const j = await (await this.request(`/contents/${encPath(path)}?ref=${encodeURIComponent(ref ?? this.ref.branch)}`)).json();
    if (Array.isArray(j)) throw new GitHubError(`${path} はディレクトリです`, 400, 'other');
    if (j.encoding === 'base64' && typeof j.content === 'string' && j.content !== '') {
      return { content: decodeBase64Utf8(j.content), sha: j.sha };
    }
    const blob = await this.getBlob(j.sha);
    return { content: new TextDecoder().decode(blob), sha: j.sha };
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const j = await (await this.request(`/git/blobs/${sha}`)).json();
    return base64ToBytes(j.content);
  }

  /** バイナリファイル（添付）の取得 */
  async getBinary(path: string): Promise<{ bytes: Uint8Array; sha: string }> {
    const j = await (await this.request(`/contents/${encPath(path)}?ref=${encodeURIComponent(this.ref.branch)}`)).json();
    if (j.encoding === 'base64' && j.content) return { bytes: base64ToBytes(j.content), sha: j.sha };
    return { bytes: await this.getBlob(j.sha), sha: j.sha };
  }

  /** ディレクトリ直下の一覧。存在しなければ空配列 */
  async listDir(path: string): Promise<{ path: string; sha: string; type: string }[]> {
    try {
      const j = await (await this.request(`/contents/${encPath(path)}?ref=${encodeURIComponent(this.ref.branch)}`)).json();
      return Array.isArray(j) ? j.map((e) => ({ path: e.path, sha: e.sha, type: e.type })) : [];
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'notfound') return [];
      throw e;
    }
  }

  /** 楽観ロック付きの保存。sha は base 版の blob sha（新規は省略） */
  async putFile(path: string, content: string, message: string, sha?: string, base64 = false): Promise<{ sha: string; commit: string }> {
    const body: Record<string, string> = {
      message,
      content: base64 ? content : encodeBase64Utf8(content),
      branch: this.ref.branch,
    };
    if (sha) body.sha = sha;
    const j = await (await this.request(`/contents/${encPath(path)}`, { method: 'PUT', body: JSON.stringify(body) })).json();
    return { sha: j.content.sha, commit: j.commit.sha };
  }

  async deleteFile(path: string, sha: string, message: string): Promise<void> {
    await this.request(`/contents/${encPath(path)}`, {
      method: 'DELETE',
      body: JSON.stringify({ message, sha, branch: this.ref.branch }),
    });
  }

  async getHead(): Promise<{ commit: string; tree: string }> {
    const ref = await (await this.request(`/git/ref/heads/${encPath(this.ref.branch)}`)).json();
    const commit = ref.object.sha as string;
    const c = await (await this.request(`/git/commits/${commit}`)).json();
    return { commit, tree: c.tree.sha };
  }

  /** ツリー全体のパス → blob sha */
  async getTreeShas(tree: string): Promise<Map<string, string>> {
    const j = await (await this.request(`/git/trees/${tree}?recursive=1`)).json();
    return new Map((j.tree as { path: string; sha: string; type: string }[]).filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  }

  /**
   * Git Data API で複数ファイルの変更を 1 コミットにまとめる。
   * build は head のツリー（パス → blob sha）を受け取って変更を返す。ファイルごとの楽観ロックの代わりに
   * ここで base と突き合わせる。ref の更新が 422（間に他のコミットが入った）なら最初からやり直す。
   */
  async commitBatch(
    /** 関数なら build の後に評価する（変更内容からメッセージを作る場合） */
    message: string | (() => string),
    build: (tree: Map<string, string>) => Promise<TreeChange[]>,
    maxAttempts = 3,
  ): Promise<{ commit: string | null; shas: Map<string, string> }> {
    for (let attempt = 1; ; attempt++) {
      const head = await this.getHead();
      const changes = await build(await this.getTreeShas(head.tree));
      if (changes.length === 0) return { commit: null, shas: new Map() };

      const shas = new Map<string, string>();
      const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
      const queue = [...changes];
      const worker = async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          if (c.content == null) {
            entries.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
            continue;
          }
          const j = await (
            await this.request('/git/blobs', {
              method: 'POST',
              body: JSON.stringify(c.base64 ? { content: c.content, encoding: 'base64' } : { content: c.content, encoding: 'utf-8' }),
            })
          ).json();
          shas.set(c.path, j.sha);
          entries.push({ path: c.path, mode: '100644', type: 'blob', sha: j.sha });
        }
      };
      // blob 作成は並列度 5
      await Promise.all(Array.from({ length: Math.min(5, changes.length) }, worker));

      const tree = await (
        await this.request('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree, tree: entries }) })
      ).json();
      const commit = await (
        await this.request('/git/commits', {
          method: 'POST',
          body: JSON.stringify({ message: typeof message === 'function' ? message() : message, tree: tree.sha, parents: [head.commit] }),
        })
      ).json();
      try {
        await this.request(`/git/refs/heads/${encPath(this.ref.branch)}`, {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit.sha, force: false }),
        });
        return { commit: commit.sha, shas };
      } catch (e) {
        if (e instanceof GitHubError && e.kind === 'unprocessable' && attempt < maxAttempts) continue;
        throw e;
      }
    }
  }

  async listCommits(path: string): Promise<CommitInfo[]> {
    const j = await (
      await this.request(`/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(this.ref.branch)}&per_page=100`)
    ).json();
    return (j as { sha: string; commit: { message: string; author?: { date: string }; committer?: { date: string } } }[]).map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      date: c.commit.committer?.date ?? c.commit.author?.date ?? '',
    }));
  }

  /** トークンの有効期限を取得（ヘッダが読めない環境では undefined） */
  async fetchTokenExpiration(): Promise<string | undefined> {
    await this.request(`${API}/user`).catch(() => undefined);
    return this.tokenExpiration;
  }
}
