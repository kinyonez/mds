import { CORE_SCHEMA, dump, load } from 'js-yaml';

/** front matter の解析結果。未知のキーも落とさずに保持する */
export interface NoteMeta {
  id: string;
  title: string;
  folder?: string;
  tags?: string[];
  created: string;
  updated: string;
  trashedFrom?: string;
  trashedAt?: string;
  [key: string]: unknown;
}

export interface Parsed {
  meta: Record<string, unknown>;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** 既知キーの書き出し順。これ以外は元の順序のまま後ろに続ける */
const KEY_ORDER = ['id', 'title', 'folder', 'tags', 'created', 'updated', 'trashedFrom', 'trashedAt'];

export class FrontMatterError extends Error {}

export function parse(content: string): Parsed {
  const m = FM_RE.exec(content);
  if (!m) return { meta: {}, body: content };
  let meta: unknown;
  try {
    meta = load(m[1], { schema: CORE_SCHEMA });
  } catch (e) {
    throw new FrontMatterError(`front matter の YAML が壊れています: ${(e as Error).message}`);
  }
  if (meta == null) meta = {};
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    throw new FrontMatterError('front matter がマップではありません');
  }
  // serialize が入れる区切りの空行 1 つは本文に含めない
  return { meta: meta as Record<string, unknown>, body: content.slice(m[0].length).replace(/^\r?\n/, '') };
}

export function serialize(meta: Record<string, unknown>, body: string): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    const v = meta[k];
    if (v === undefined || v === null) continue;
    if (k === 'folder' && v === '') continue;
    if (k === 'tags' && Array.isArray(v) && v.length === 0) continue;
    ordered[k] = v;
  }
  for (const [k, v] of Object.entries(meta)) {
    if (KEY_ORDER.includes(k) || v === undefined) continue;
    ordered[k] = v;
  }
  const yaml = dump(ordered, { flowLevel: 1, lineWidth: -1 });
  return `---\n${yaml}---\n\n${body}`;
}
