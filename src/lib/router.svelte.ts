/** ハッシュルーティング: #/note/<id>、#/folder/<path>?tags=a,b、#/tag/<name>、#/search?q=、#/trash、#/unfiled、#/settings */

export type Route =
  | { name: 'all'; tags: string[] }
  | { name: 'folder'; path: string; tags: string[] }
  | { name: 'unfiled'; tags: string[] }
  | { name: 'tag'; tag: string; tags: string[] }
  | { name: 'trash'; tags: string[] }
  | { name: 'note'; id: string }
  | { name: 'settings' };

export type ListRoute = Exclude<Route, { name: 'note' } | { name: 'settings' }>;

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const tags = (params.get('tags') ?? '').split(',').filter(Boolean);
  const segs = pathPart.split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  switch (segs[0]) {
    case 'note':
      return segs[1] ? { name: 'note', id: segs[1] } : { name: 'all', tags };
    case 'folder':
      return { name: 'folder', path: segs.slice(1).join('/'), tags };
    case 'unfiled':
      return { name: 'unfiled', tags };
    case 'tag':
      return { name: 'tag', tag: segs[1] ?? '', tags };
    case 'trash':
      return { name: 'trash', tags };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'all', tags };
  }
}

export function href(r: Route): string {
  const q = 'tags' in r && r.tags.length ? `?tags=${r.tags.map(encodeURIComponent).join(',')}` : '';
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  switch (r.name) {
    case 'note':
      return `#/note/${r.id}`;
    case 'folder':
      return `#/folder/${enc(r.path)}${q}`;
    case 'unfiled':
      return `#/unfiled${q}`;
    case 'tag':
      return `#/tag/${encodeURIComponent(r.tag)}${q}`;
    case 'trash':
      return `#/trash${q}`;
    case 'settings':
      return '#/settings';
    default:
      return `#/${q}`;
  }
}

class Router {
  route = $state<Route>(parseHash(location.hash));
  /** 直近の一覧（ノートを開いている間も中央ペインに出す） */
  list = $state<ListRoute>({ name: 'all', tags: [] });

  constructor() {
    this.sync();
    addEventListener('hashchange', () => this.sync());
  }

  private sync() {
    const r = parseHash(location.hash);
    this.route = r;
    if (r.name !== 'note' && r.name !== 'settings') this.list = r;
  }

  go(r: Route | string) {
    location.hash = typeof r === 'string' ? r : href(r);
  }
}

export const router = new Router();
