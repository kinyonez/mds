import { createHash } from 'node:crypto';

/** GitHub REST API（Contents / Git Data）の最小限のインメモリ実装 */

type Files = Map<string, Uint8Array>;

interface Commit {
  sha: string;
  tree: string;
  parent: string | null;
  message: string;
  files: Files;
  date: string;
}

function gitSha(kind: string, data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = createHash('sha1');
  h.update(`${kind} ${bytes.length}\0`);
  h.update(bytes);
  return h.digest('hex');
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

export type Failure = { status: number; headers?: Record<string, string> } | 'network';

export class FakeGitHub {
  commits: Commit[] = [];
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Files>();
  requests: { method: string; path: string }[] = [];
  /** 次のリクエストを失敗させる */
  failures: Failure[] = [];
  /** 特定のメソッド・パスだけ失敗させる */
  failWhen: ((method: string, path: string) => Failure | undefined) | null = null;

  constructor(
    readonly owner = 'me',
    readonly repo = 'notes-data',
  ) {
    this.commit(new Map(), 'init');
  }

  get head(): Commit {
    return this.commits[this.commits.length - 1];
  }

  files(): Files {
    return this.head.files;
  }

  read(path: string): string | undefined {
    const b = this.files().get(path);
    return b && dec(b);
  }

  sha(path: string): string | undefined {
    const b = this.files().get(path);
    return b && gitSha('blob', b);
  }

  /** 別デバイスからのコミットを模擬する */
  write(path: string, content: string | null, message = 'external'): void {
    const files = new Map(this.files());
    if (content == null) files.delete(path);
    else files.set(path, enc(content));
    this.commit(files, message);
  }

  private commit(files: Files, message: string, parent = this.commits.length ? this.head.sha : null): Commit {
    const tree = this.storeTree(files);
    const sha = gitSha('commit', `${tree}${parent}${message}${this.commits.length}`);
    const c: Commit = { sha, tree, parent, message, files, date: new Date(Date.UTC(2026, 9, 23, 0, this.commits.length)).toISOString() };
    this.commits.push(c);
    return c;
  }

  private storeTree(files: Files): string {
    const key = [...files].map(([p, b]) => `${p}:${gitSha('blob', b)}`).sort().join('\n');
    const sha = gitSha('tree', key);
    this.trees.set(sha, new Map(files));
    for (const b of files.values()) this.blobs.set(gitSha('blob', b), b);
    return sha;
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    this.requests.push({ method, path: url.pathname + url.search });
    const f = this.failures.shift() ?? this.failWhen?.(method, url.pathname);
    if (f === 'network') throw new TypeError('Failed to fetch');
    if (f) return json({ message: 'injected failure' }, f.status, f.headers);

    const headers = new Headers(init.headers);
    if (!headers.get('authorization')?.startsWith('Bearer ')) return json({ message: 'Bad credentials' }, 401);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;

    const base = `/repos/${this.owner}/${this.repo}`;
    if (url.pathname === '/user') return json({ login: this.owner });
    if (!url.pathname.startsWith(base)) return json({ message: 'Not Found' }, 404);
    const rest = url.pathname.slice(base.length);

    if (rest === '' && method === 'GET') return json({ private: true, permissions: { push: true }, default_branch: 'main' });

    if (rest.startsWith('/contents/')) {
      const path = decodeURIComponent(rest.slice('/contents/'.length));
      return this.contents(method, path, url, headers, body);
    }
    if (rest === '/git/ref/heads/main' && method === 'GET') return json({ object: { sha: this.head.sha } });
    let m;
    if ((m = /^\/git\/commits\/(\w+)$/.exec(rest)) && method === 'GET') {
      const c = this.commits.find((x) => x.sha === m![1]);
      return c ? json({ sha: c.sha, tree: { sha: c.tree } }) : json({ message: 'Not Found' }, 404);
    }
    if ((m = /^\/git\/trees\/(\w+)$/.exec(rest)) && method === 'GET') {
      const t = this.trees.get(m[1]);
      if (!t) return json({ message: 'Not Found' }, 404);
      return json({ sha: m[1], tree: [...t].map(([path, b]) => ({ path, type: 'blob', sha: gitSha('blob', b) })) });
    }
    if ((m = /^\/git\/blobs\/(\w+)$/.exec(rest)) && method === 'GET') {
      const b = this.blobs.get(m[1]);
      return b ? json({ sha: m[1], content: b64(b), encoding: 'base64' }) : json({ message: 'Not Found' }, 404);
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const b = body.encoding === 'base64' ? unb64(body.content) : enc(body.content);
      const sha = gitSha('blob', b);
      this.blobs.set(sha, b);
      return json({ sha }, 201);
    }
    if (rest === '/git/trees' && method === 'POST') {
      const files = new Map(this.trees.get(body.base_tree) ?? []);
      for (const e of body.tree) {
        if (e.sha === null) {
          if (!files.has(e.path)) return json({ message: `path ${e.path} not found` }, 422);
          files.delete(e.path);
        } else files.set(e.path, this.blobs.get(e.sha)!);
      }
      return json({ sha: this.storeTree(files) }, 201);
    }
    if (rest === '/git/commits' && method === 'POST') {
      const files = this.trees.get(body.tree)!;
      const sha = gitSha('commit', `${body.tree}${body.parents[0]}${body.message}${Math.random()}`);
      this.pendingCommits.set(sha, { sha, tree: body.tree, parent: body.parents[0], message: body.message, files, date: new Date().toISOString() });
      return json({ sha }, 201);
    }
    if (rest === '/git/refs/heads/main' && method === 'PATCH') {
      const c = this.pendingCommits.get(body.sha);
      if (!c) return json({ message: 'Object does not exist' }, 422);
      if (c.parent !== this.head.sha && !body.force) return json({ message: 'Update is not a fast forward' }, 422);
      this.commits.push(c);
      return json({ object: { sha: c.sha } });
    }
    if (rest === '/commits' && method === 'GET') {
      const path = url.searchParams.get('path')!;
      const out = [];
      for (let i = this.commits.length - 1; i > 0; i--) {
        const a = this.commits[i].files.get(path);
        const b = this.commits[i - 1].files.get(path);
        if ((a && gitSha('blob', a)) !== (b && gitSha('blob', b))) {
          const c = this.commits[i];
          out.push({ sha: c.sha, commit: { message: c.message, committer: { date: c.date } } });
        }
      }
      return json(out);
    }
    return json({ message: `unhandled ${method} ${rest}` }, 404);
  };

  private pendingCommits = new Map<string, Commit>();

  private contents(method: string, path: string, url: URL, headers: Headers, body: any): Response {
    const ref = url.searchParams.get('ref');
    const commit = ref && ref !== 'main' ? this.commits.find((c) => c.sha === ref) : this.head;
    if (!commit) return json({ message: 'No commit found' }, 404);
    const files = commit.files;
    if (method === 'GET') {
      const b = files.get(path);
      if (!b) {
        const children = [...files.keys()].filter((p) => p.startsWith(path + '/'));
        if (children.length) {
          return json(
            children
              .filter((p) => !p.slice(path.length + 1).includes('/'))
              .map((p) => ({ path: p, type: 'file', sha: gitSha('blob', files.get(p)!) })),
          );
        }
        return json({ message: 'Not Found' }, 404);
      }
      const sha = gitSha('blob', b);
      if (headers.get('accept') === 'application/vnd.github.raw+json') {
        const etag = `"${sha}"`;
        if (headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
        return new Response(dec(b), { status: 200, headers: { etag } });
      }
      return json({ path, sha, encoding: 'base64', content: b64(b) });
    }
    if (method === 'PUT') {
      const cur = this.head.files.get(path);
      const curSha = cur && gitSha('blob', cur);
      if (cur && !body.sha) return json({ message: '"sha" wasn\'t supplied.' }, 422);
      if (body.sha && body.sha !== curSha) return json({ message: `${path} does not match ${body.sha}` }, 409);
      const next = new Map(this.head.files);
      const bytes = unb64(body.content);
      next.set(path, bytes);
      const c = this.commit(next, body.message);
      return json({ content: { path, sha: gitSha('blob', bytes) }, commit: { sha: c.sha } }, cur ? 200 : 201);
    }
    if (method === 'DELETE') {
      const cur = this.head.files.get(path);
      if (!cur) return json({ message: 'Not Found' }, 404);
      if (body.sha !== gitSha('blob', cur)) return json({ message: 'sha mismatch' }, 409);
      const next = new Map(this.head.files);
      next.delete(path);
      const c = this.commit(next, body.message);
      return json({ commit: { sha: c.sha } });
    }
    return json({ message: 'Method not allowed' }, 405);
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
