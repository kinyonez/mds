import { diff3Merge } from 'node-diff3';
import { parse, serialize } from '../domain/frontmatter';
import { normalizeTags, timeOf } from '../domain/note';

export type MergeResult = { ok: true; content: string } | { ok: false; conflicts: string[] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function splitLines(s: string): string[] {
  return s.split('\n');
}

/** 本文の行単位 3-way マージ。同じ箇所を両側が変えていたら null */
export function mergeBody(base: string, local: string, remote: string): string | null {
  if (local === remote) return local;
  if (local === base) return remote;
  if (remote === base) return local;
  const blocks = diff3Merge(splitLines(local), splitLines(base), splitLines(remote), { excludeFalseConflicts: true });
  const out: string[] = [];
  for (const b of blocks) {
    if (b.conflict) return null;
    out.push(...(b.ok ?? []));
  }
  return out.join('\n');
}

/** tags は集合として、両側の追加・削除を base に適用する */
export function mergeTags(base: string[], local: string[], remote: string[]): string[] {
  const b = new Set(base);
  const removed = new Set([...base.filter((t) => !local.includes(t)), ...base.filter((t) => !remote.includes(t))]);
  const out: string[] = [];
  for (const t of [...local, ...remote, ...base]) {
    if (out.includes(t) || removed.has(t)) continue;
    if (b.has(t) || local.includes(t) || remote.includes(t)) out.push(t);
  }
  return out;
}

/**
 * ノートの 3-way マージ。
 * - 本文は行単位の diff3
 * - front matter はキー単位。tags は集合差分を両側から適用、updated は新しい方
 * - folder / title / その他のキーは両側が別の値に変えていたら競合
 * 「とりあえず新しい方」を黙って選ぶことはしない。
 */
export function mergeNote(base: string | null, local: string, remote: string): MergeResult {
  if (local === remote) return { ok: true, content: local };
  if (base == null) return { ok: false, conflicts: ['base'] };
  if (local === base) return { ok: true, content: remote };
  if (remote === base) return { ok: true, content: local };

  let pb, pl, pr;
  try {
    pb = parse(base);
    pl = parse(local);
    pr = parse(remote);
  } catch {
    return { ok: false, conflicts: ['frontmatter'] };
  }
  const conflicts: string[] = [];
  const meta: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(pl.meta), ...Object.keys(pr.meta), ...Object.keys(pb.meta)]);

  for (const k of keys) {
    const b = pb.meta[k];
    const l = pl.meta[k];
    const r = pr.meta[k];
    if (k === 'tags') {
      const merged = mergeTags(normalizeTags(b), normalizeTags(l), normalizeTags(r));
      if (merged.length) meta.tags = merged;
      continue;
    }
    if (k === 'updated') {
      meta.updated = timeOf(String(l ?? '')) >= timeOf(String(r ?? '')) ? l : r;
      continue;
    }
    if (same(l, r)) {
      if (l !== undefined) meta[k] = l;
    } else if (same(l, b)) {
      if (r !== undefined) meta[k] = r;
    } else if (same(r, b)) {
      if (l !== undefined) meta[k] = l;
    } else {
      conflicts.push(k);
    }
  }

  const body = mergeBody(pb.body, pl.body, pr.body);
  if (body == null) conflicts.push('body');
  if (conflicts.length) return { ok: false, conflicts };

  // キーの並びはローカル版に揃える
  const ordered: Record<string, unknown> = {};
  for (const k of [...Object.keys(pl.meta), ...Object.keys(meta)]) if (k in meta) ordered[k] = meta[k];
  return { ok: true, content: serialize(ordered, body!) };
}
