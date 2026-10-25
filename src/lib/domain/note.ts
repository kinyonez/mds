import { monotonicFactory } from 'ulid';
import { parse, serialize, type NoteMeta } from './frontmatter';
import type { NoteSummary } from './types';

export const TRASH = '_trash';
/** テンプレート用の予約フォルダ */
export const TEMPLATES = '_templates';
export const UNFILED = '';

const newUlid = monotonicFactory();

export function newId(): string {
  return newUlid();
}

export function nowIso(date = new Date()): string {
  // タイムゾーン付きのローカル時刻（例: 2026-10-23T19:40:00+09:00）
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export class NormalizeError extends Error {}

const FORBIDDEN = /[\\:*?"<>`]/;

/**
 * folder の正規化。NFC、前後の空白と / を除去、連続 / を圧縮、各セグメントの前後空白を除去。
 * 大文字小文字は区別する。_trash は予約名なので allowTrash 以外では拒否する。
 */
export function normalizeFolder(input: string | undefined | null, opts: { allowTrash?: boolean; allowTemplates?: boolean } = {}): string {
  if (input == null) return '';
  const s = String(input).normalize('NFC').trim().replace(/^\/+|\/+$/g, '');
  if (s === '') return '';
  const segs = s.split(/\/+/).map((x) => x.trim());
  for (const seg of segs) {
    if (seg === '') throw new NormalizeError('空のフォルダ名は使えません');
    if (FORBIDDEN.test(seg)) throw new NormalizeError(`フォルダ名に使えない文字が含まれています: ${seg}`);
    if (seg === '.' || seg === '..') throw new NormalizeError(`フォルダ名に ${seg} は使えません`);
  }
  if (segs[0] === TRASH && !opts.allowTrash) throw new NormalizeError(`${TRASH} は予約名です`);
  if (segs[0] === TEMPLATES && !opts.allowTemplates) throw new NormalizeError(`${TEMPLATES} は予約名です`);
  return segs.join('/');
}

/** tag の正規化。NFC、前後空白除去、先頭 # 除去、内部空白を - に、小文字化 */
export function normalizeTag(input: string): string {
  return String(input)
    .normalize('NFC')
    .trim()
    .replace(/^#+/, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    if (typeof tags === 'string' && tags.trim()) tags = tags.split(',');
    else return [];
  }
  const out: string[] = [];
  for (const t of tags as unknown[]) {
    if (t == null) continue;
    const n = normalizeTag(String(t));
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export function isTrashed(meta: { folder?: string }): boolean {
  const f = meta.folder ?? '';
  return f === TRASH || f.startsWith(TRASH + '/');
}

export function isTemplate(meta: { folder?: string }): boolean {
  const f = meta.folder ?? '';
  return f === TEMPLATES || f.startsWith(TEMPLATES + '/');
}

/** ゴミ箱とテンプレート。フォルダツリー・タグ一覧・通常の一覧と検索から除外する */
export function isReserved(meta: { folder?: string }): boolean {
  return isTrashed(meta) || isTemplate(meta);
}

/** title が空なら本文の 1 行目をタイトルとして扱う */
export function displayTitle(meta: { title?: unknown }, body?: string): string {
  const t = typeof meta.title === 'string' ? meta.title.trim() : '';
  if (t) return t;
  if (body) {
    const line = body.split('\n').find((l) => l.trim());
    if (line) return line.replace(/^#+\s*/, '').trim().slice(0, 80);
  }
  return '無題';
}

/** 解析済みメタデータを型付きの NoteMeta に揃える（未知のキーは保持） */
export function toMeta(raw: Record<string, unknown>, fallbackId?: string): NoteMeta {
  const str = (v: unknown) => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v));
  let folder = '';
  try {
    folder = normalizeFolder(str(raw.folder), { allowTrash: true, allowTemplates: true });
  } catch {
    folder = str(raw.folder);
  }
  return {
    ...raw,
    id: str(raw.id) || fallbackId || '',
    title: str(raw.title),
    folder,
    tags: normalizeTags(raw.tags),
    created: str(raw.created),
    updated: str(raw.updated),
  };
}

export interface ParsedNote {
  meta: NoteMeta;
  body: string;
}

export function parseNote(content: string, fallbackId?: string): ParsedNote {
  const { meta, body } = parse(content);
  return { meta: toMeta(meta, fallbackId), body };
}

export function serializeNote(meta: NoteMeta, body: string): string {
  return serialize(meta as Record<string, unknown>, body);
}

export function createNoteContent(
  opts: { id?: string; title?: string; folder?: string; tags?: string[]; body?: string; now?: Date; extra?: Record<string, unknown> } = {},
): {
  id: string;
  content: string;
} {
  const id = opts.id ?? newId();
  const ts = nowIso(opts.now);
  const meta: NoteMeta = {
    id,
    title: opts.title ?? '',
    folder: normalizeFolder(opts.folder ?? '', { allowTemplates: true }),
    tags: normalizeTags(opts.tags ?? []),
    created: ts,
    updated: ts,
    ...opts.extra,
  };
  return { id, content: serializeNote(meta, opts.body ?? '') };
}

/** front matter を書き換える。updated は自動で更新する */
export function updateMeta(content: string, patch: Partial<NoteMeta>, now?: Date): string {
  const { meta, body } = parseNote(content);
  const next: NoteMeta = { ...meta, ...patch, updated: nowIso(now) };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
  return serializeNote(next, body);
}

export function updateBody(content: string, body: string, now?: Date): string {
  const { meta } = parseNote(content);
  return serializeNote({ ...meta, updated: nowIso(now) }, body);
}

export function moveToTrash(content: string, now = new Date()): string {
  const { meta } = parseNote(content);
  if (isTrashed(meta)) return content;
  return updateMeta(content, { folder: TRASH, trashedFrom: meta.folder ?? '', trashedAt: nowIso(now) }, now);
}

export function restoreFromTrash(content: string, now = new Date()): string {
  const { meta } = parseNote(content);
  return updateMeta(content, { folder: String(meta.trashedFrom ?? ''), trashedFrom: undefined, trashedAt: undefined }, now);
}

const LINK_RE = /\[\[([0-9A-HJKMNP-TV-Z]{26})(?:\|[^\]]*)?\]\]/g;

export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(LINK_RE)) out.add(m[1]);
  return [...out];
}

export function excerpt(body: string, len = 200): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, len);
}

export function notePath(id: string): string {
  return `notes/${id}.md`;
}

export function attachmentDir(id: string): string {
  return `attachments/${id}`;
}

/** フォルダ prefix の置換。from 自身と配下が対象 */
export function replaceFolderPrefix(folder: string, from: string, to: string): string | null {
  if (folder === from) return to;
  if (folder.startsWith(from + '/')) return (to ? to + '/' : '') + folder.slice(from.length + 1);
  return null;
}

export function timeOf(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export type ListSort = 'updated-desc' | 'created-desc' | 'created-asc' | 'title-asc' | 'title-desc';

/** 一覧の並び順。同順位は更新日の新しい順 */
export function compareNotes(sort: ListSort): (a: NoteSummary, b: NoteSummary) => number {
  const byUpdated = (a: NoteSummary, b: NoteSummary) => timeOf(b.updated) - timeOf(a.updated);
  const primary = {
    'updated-desc': () => 0,
    'created-desc': (a: NoteSummary, b: NoteSummary) => timeOf(b.created) - timeOf(a.created),
    'created-asc': (a: NoteSummary, b: NoteSummary) => timeOf(a.created) - timeOf(b.created),
    'title-asc': (a: NoteSummary, b: NoteSummary) => a.title.localeCompare(b.title, 'ja'),
    'title-desc': (a: NoteSummary, b: NoteSummary) => b.title.localeCompare(a.title, 'ja'),
  }[sort];
  return (a, b) => primary(a, b) || byUpdated(a, b);
}
