import { isReserved } from './note';
import type { NoteSummary } from './types';

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  /** 直下のノート件数 */
  direct: number;
  /** 配下合計のノート件数 */
  total: number;
}

/** work/network/testing → work, work/network, work/network/testing */
export function expandPaths(folder: string): string[] {
  if (!folder) return [];
  const segs = folder.split('/');
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'));
}

/** フォルダツリーは「全ノートの folder の集合 ∪ folders.json」から導出する。_trash は除外 */
export function buildTree(folders: Iterable<string>, notes: NoteSummary[]): FolderNode {
  const root: FolderNode = { name: '', path: '', children: [], direct: 0, total: 0 };
  const byPath = new Map<string, FolderNode>([['', root]]);

  const ensure = (path: string): FolderNode => {
    const hit = byPath.get(path);
    if (hit) return hit;
    const i = path.lastIndexOf('/');
    const parent = ensure(i < 0 ? '' : path.slice(0, i));
    const node: FolderNode = { name: path.slice(i + 1), path, children: [], direct: 0, total: 0 };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };

  for (const f of folders) {
    if (f && !isReserved({ folder: f })) ensure(f);
  }
  for (const n of notes) {
    if (isReserved(n)) continue;
    const node = ensure(n.folder);
    node.direct++;
    for (const p of ['', ...expandPaths(n.folder)]) byPath.get(p)!.total++;
  }
  const sort = (n: FolderNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** タグ → 件数（_trash と _templates を除く）。件数の降順、同数は名前順 */
export function tagCounts(notes: NoteSummary[]): [string, number][] {
  const m = new Map<string, number>();
  for (const n of notes) {
    if (isReserved(n)) continue;
    for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function inFolder(n: { folder: string }, folder: string, recursive: boolean): boolean {
  if (n.folder === folder) return true;
  return recursive && folder !== '' && n.folder.startsWith(folder + '/');
}
