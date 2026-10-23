import { describe, expect, it } from 'vitest';
import { parse, serialize } from '../src/lib/domain/frontmatter';
import {
  NormalizeError,
  createNoteContent,
  displayTitle,
  extractLinks,
  moveToTrash,
  normalizeFolder,
  normalizeTag,
  normalizeTags,
  parseNote,
  replaceFolderPrefix,
  restoreFromTrash,
} from '../src/lib/domain/note';
import { SearchIndex, tokenize } from '../src/lib/domain/search';
import { buildTree, tagCounts } from '../src/lib/domain/tree';
import type { NoteSummary } from '../src/lib/domain/types';
import { mergeNote, mergeTags } from '../src/lib/sync/merge';
import { applyFolderSet } from '../src/lib/sync/sync';

describe('正規化', () => {
  it('folder', () => {
    expect(normalizeFolder('  /work//network/ testing /  ')).toBe('work/network/testing');
    expect(normalizeFolder('Work')).toBe('Work'); // 大文字小文字は区別
    expect(normalizeFolder('')).toBe('');
    expect(normalizeFolder('ｶﾞ'.normalize('NFD'))).toBe('ｶﾞ'.normalize('NFC'));
    expect(() => normalizeFolder('a/ /b')).toThrow(NormalizeError);
    expect(() => normalizeFolder('a:b')).toThrow(NormalizeError);
    expect(() => normalizeFolder('a/b?')).toThrow(NormalizeError);
    expect(() => normalizeFolder('_trash')).toThrow(NormalizeError);
    expect(() => normalizeFolder('_trash/x')).toThrow(NormalizeError);
    expect(normalizeFolder('_trash', { allowTrash: true })).toBe('_trash');
  });

  it('tags', () => {
    expect(normalizeTag('  #Open Config ')).toBe('open-config');
    expect(normalizeTags(['A', 'a', '#a', ' b '])).toEqual(['a', 'b']);
    expect(normalizeTags('x, y')).toEqual(['x', 'y']);
  });
});

describe('front matter', () => {
  it('未知のキーを保持して書き戻す', () => {
    const src = '---\nid: X\ntitle: t\npinned: true\ncustom:\n  a: 1\n---\n\nbody\n';
    const { meta, body } = parse(src);
    expect(body).toBe('body\n');
    const out = serialize({ ...meta, title: 'u' }, body);
    const again = parse(out);
    expect(again.meta).toEqual({ id: 'X', title: 'u', pinned: true, custom: { a: 1 } });
    expect(again.body).toBe('body\n');
  });

  it('タイムスタンプは文字列のまま扱う', () => {
    const { meta } = parseNote('---\nid: X\ncreated: 2026-10-23T19:40:00+09:00\n---\n');
    expect(meta.created).toBe('2026-10-23T19:40:00+09:00');
  });

  it('壊れた YAML はエラー', () => {
    expect(() => parse('---\na: [\n---\n')).toThrow();
  });

  it('新規ノートは設計どおりの形', () => {
    const { id, content } = createNoteContent({ title: 'gNMI', folder: 'work/network', tags: ['GNMI'], body: '本文', now: new Date('2026-10-23T10:40:00Z') });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const { meta, body } = parseNote(content);
    expect(meta).toMatchObject({ id, title: 'gNMI', folder: 'work/network', tags: ['gnmi'] });
    expect(meta.created).toMatch(/^2026-10-23T\d\d:40:00[+-]\d\d:\d\d$/);
    expect(body).toBe('本文');
  });

  it('タイトルが空なら本文 1 行目', () => {
    expect(displayTitle({ title: '' }, '\n# 見出し\n本文')).toBe('見出し');
  });

  it('ゴミ箱への移動と復元', () => {
    const { content } = createNoteContent({ folder: 'a/b', body: 'x' });
    const t = parseNote(moveToTrash(content)).meta;
    expect(t.folder).toBe('_trash');
    expect(t.trashedFrom).toBe('a/b');
    expect(t.trashedAt).toBeTruthy();
    const r = parseNote(restoreFromTrash(moveToTrash(content))).meta;
    expect(r.folder).toBe('a/b');
    expect('trashedFrom' in r).toBe(false);
  });

  it('リンク抽出', () => {
    expect(extractLinks('see [[01JB3K8W2M9X7QZ4R6T1V5N0PB]] and [[01JB3K8W2M9X7QZ4R6T1V5N0PC|名前]]')).toEqual([
      '01JB3K8W2M9X7QZ4R6T1V5N0PB',
      '01JB3K8W2M9X7QZ4R6T1V5N0PC',
    ]);
  });

  it('フォルダ prefix 置換', () => {
    expect(replaceFolderPrefix('work/net', 'work', 'job')).toBe('job/net');
    expect(replaceFolderPrefix('workshop', 'work', 'job')).toBeNull();
    expect(replaceFolderPrefix('work', 'work', '')).toBe('');
  });
});

describe('3-way マージ', () => {
  const doc = (meta: string, body: string) => `---\n${meta}\n---\n\n${body}`;

  it('folder を両側が別々に変えたら競合', () => {
    const base = doc('id: X\nfolder: a', 'x');
    const r = mergeNote(base, doc('id: X\nfolder: b', 'x'), doc('id: X\nfolder: c', 'x'));
    expect(r).toEqual({ ok: false, conflicts: ['folder'] });
  });

  it('片側だけの folder 変更と、もう片側の本文変更は統合', () => {
    const base = doc('id: X\nfolder: a', 'l1\nl2');
    const r = mergeNote(base, doc('id: X\nfolder: b', 'l1\nl2'), doc('id: X\nfolder: a', 'l1\nL2'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(parseNote(r.content)).toMatchObject({ meta: { folder: 'b' }, body: 'l1\nL2' });
  });

  it('updated は新しい方', () => {
    const base = doc("id: X\nupdated: '2026-10-23T10:00:00+09:00'", 'a\n-\nb');
    const r = mergeNote(
      base,
      doc("id: X\nupdated: '2026-10-23T11:00:00+09:00'", 'A\n-\nb'),
      doc("id: X\nupdated: '2026-10-23T12:00:00+09:00'", 'a\n-\nB'),
    );
    expect(r.ok && parseNote(r.content).meta.updated).toBe('2026-10-23T12:00:00+09:00');
  });

  it('tags は集合の差分を両側から適用', () => {
    expect(mergeTags(['a', 'b', 'c'], ['a', 'c', 'x'], ['a', 'b', 'y'])).toEqual(['a', 'x', 'y']);
  });

  it('base が無ければ自動解決しない', () => {
    expect(mergeNote(null, 'a', 'b').ok).toBe(false);
  });
});

describe('ツリーと集計', () => {
  const n = (id: string, folder: string, tags: string[] = []): NoteSummary => ({
    id, title: id, folder, tags, created: '', updated: '', excerpt: '', links: [], local: false,
  });

  it('中間パスを展開し、直下件数と合計件数を数える。_trash は除外', () => {
    const root = buildTree(['personal/reading'], [n('1', 'work/network/testing'), n('2', 'work'), n('3', ''), n('4', '_trash')]);
    expect(root.total).toBe(3);
    const work = root.children.find((c) => c.name === 'work')!;
    expect(work.direct).toBe(1);
    expect(work.total).toBe(2);
    expect(work.children[0].children[0].path).toBe('work/network/testing');
    expect(root.children.map((c) => c.name)).toEqual(['personal', 'work']);
    expect(root.children.find((c) => c.name === '_trash')).toBeUndefined();
  });

  it('タグは件数の降順', () => {
    expect(tagCounts([n('1', '', ['a', 'b']), n('2', '', ['b']), n('3', '_trash', ['c'])])).toEqual([
      ['b', 2],
      ['a', 1],
    ]);
  });

  it('folders.json の集合マージ', () => {
    expect(applyFolderSet(['a', 'a/b', 'c'], ['d'], ['a'])).toEqual(['c', 'd']);
    expect(applyFolderSet(['work/empty', 'x'], [], [], [['work', 'job']])).toEqual(['job/empty', 'x']);
  });
});

describe('検索', () => {
  it('日本語は bigram、英数字は単語', () => {
    expect(tokenize('再接続の挙動 gNMI Subscribe')).toEqual(['再接', '接続', '続の', 'の挙', '挙動', 'gnmi', 'subscribe']);
  });

  it('日本語の部分一致と英数字の前方一致', () => {
    const s = new SearchIndex();
    s.reset([
      { id: '1', title: 'gNMI Subscribe の再接続挙動メモ', text: 'ondatra でテスト' },
      { id: '2', title: '読書メモ', text: 'ベケット' },
    ]);
    expect(s.search('再接続').map((r) => r.id)).toEqual(['1']);
    expect(s.search('subs').map((r) => r.id)).toEqual(['1']);
    expect(s.search('メモ').map((r) => r.id).sort()).toEqual(['1', '2']);
    expect(s.search('ベケット').map((r) => r.id)).toEqual(['2']);
    s.upsert({ id: '2', title: '読書メモ', text: '本文を取得して差し替え' });
    expect(s.search('ベケット')).toEqual([]);
    expect(s.search('差し替え').map((r) => r.id)).toEqual(['2']);
  });
});
