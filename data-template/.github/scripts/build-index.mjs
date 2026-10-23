// notes/*.md を全件読み、front matter を解析して index.json を書き出す。
// notes-data リポの GitHub Actions から push のたびに実行される。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { CORE_SCHEMA, load } from 'js-yaml';

const TRASH = '_trash';
const EXCERPT_LEN = 200;
const LINK_RE = /\[\[([0-9A-HJKMNP-TV-Z]{26})(?:\|[^\]]*)?\]\]/g;

/** git の blob SHA（Contents API の sha と同じ値） */
export function blobSha(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

const isTrashed = (folder) => folder === TRASH || folder.startsWith(TRASH + '/');

function expand(folder) {
  if (!folder) return [];
  const segs = folder.split('/');
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'));
}

function str(v) {
  if (v == null) return '';
  return v instanceof Date ? v.toISOString() : String(v);
}

function normalizeFolder(v) {
  return str(v)
    .normalize('NFC')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split(/\/+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

function normalizeTags(v) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = [];
  for (const t of arr) {
    const n = str(t).normalize('NFC').trim().replace(/^#+/, '').trim().replace(/\s+/g, '-').toLowerCase();
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function excerpt(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXCERPT_LEN);
}

function title(meta, body) {
  const t = str(meta.title).trim();
  if (t) return t;
  const line = body.split('\n').find((l) => l.trim());
  return line ? line.replace(/^#+\s*/, '').trim().slice(0, 80) : '';
}

/**
 * @param {{ path: string, buf: Buffer }[]} files notes/*.md
 * @param {string | null} foldersJson _meta/folders.json の内容
 * @param {{ commit?: string, now?: Date }} opts
 */
export function buildIndex(files, foldersJson, opts = {}) {
  const notes = [];
  const folders = new Set();
  const tags = {};

  for (const { path, buf } of files) {
    const id = path.replace(/^notes\//, '').replace(/\.md$/, '');
    const sha = blobSha(buf);
    const text = buf.toString('utf8');
    let parsed;
    try {
      // クライアント（js-yaml）と同じパーサで、タイムスタンプも文字列のまま扱う
      parsed = matter(text, { engines: { yaml: (s) => load(s, { schema: CORE_SCHEMA }) ?? {} } });
      if (typeof parsed.data !== 'object' || Array.isArray(parsed.data)) throw new Error('front matter がマップではありません');
    } catch (e) {
      // 黙って消えると探せなくなるので、エラー付きで残す
      notes.push({ id, path, sha, title: id, folder: '', tags: [], created: '', updated: '', excerpt: '', links: [], error: String(e.message ?? e) });
      continue;
    }
    const meta = parsed.data;
    const body = parsed.content.replace(/^\r?\n/, '');
    const folder = normalizeFolder(meta.folder);
    const noteTags = normalizeTags(meta.tags);
    const entry = {
      id: str(meta.id) || id,
      path,
      sha,
      title: title(meta, body),
      folder,
      tags: noteTags,
      created: str(meta.created),
      updated: str(meta.updated),
      excerpt: excerpt(body),
      links: [...new Set([...body.matchAll(LINK_RE)].map((m) => m[1]))],
    };
    if (meta.trashedAt) entry.trashedAt = str(meta.trashedAt);
    if (meta.trashedFrom != null) entry.trashedFrom = str(meta.trashedFrom);
    if (entry.id !== id) entry.error = `front matter の id (${entry.id}) がファイル名と一致しません`;
    notes.push(entry);
    // folders と tags は _trash を除いて集計する（notes[] には含める）
    if (isTrashed(folder)) continue;
    for (const p of expand(folder)) folders.add(p);
    for (const t of noteTags) tags[t] = (tags[t] ?? 0) + 1;
  }

  if (foldersJson) {
    try {
      const j = JSON.parse(foldersJson);
      for (const f of j.folders ?? []) {
        const n = normalizeFolder(f);
        if (n && !isTrashed(n)) for (const p of expand(n)) folders.add(p);
      }
    } catch {
      /* 壊れていれば無視 */
    }
  }

  notes.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    commit: opts.commit ?? '',
    folders: [...folders].sort(),
    tags: Object.fromEntries(Object.entries(tags).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    notes,
  };
}

function main() {
  const root = process.cwd();
  const dir = join(root, 'notes');
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => ({ path: `notes/${f}`, buf: readFileSync(join(dir, f)) }))
    : [];
  const fj = join(root, '_meta', 'folders.json');
  let commit = process.env.GITHUB_SHA ?? '';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    /* git が無い環境 */
  }
  const index = buildIndex(files, existsSync(fj) ? readFileSync(fj, 'utf8') : null, { commit });
  writeFileSync(join(root, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  console.log(`index.json: ${index.notes.length} notes, ${index.folders.length} folders, ${Object.keys(index.tags).length} tags`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
