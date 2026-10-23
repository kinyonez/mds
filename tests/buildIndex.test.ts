import { describe, expect, it } from 'vitest';
import { blobSha, buildIndex } from '../data-template/.github/scripts/build-index.mjs';
import { createNoteContent, moveToTrash } from '../src/lib/domain/note';

const file = (id: string, content: string) => ({ path: `notes/${id}.md`, buf: Buffer.from(content) });

describe('build-index.mjs', () => {
  it('スキーマどおりの index を作り、_trash を folders と tags から除く', () => {
    const a = createNoteContent({ title: 'A', folder: 'work/network/testing', tags: ['gnmi', 'ondatra'], body: 'see [[01JB3K8W2M9X7QZ4R6T1V5N0PB]]' });
    const b = createNoteContent({ title: 'B', folder: 'personal', tags: ['gnmi'], body: '# 本文\n' });
    const c = createNoteContent({ title: 'C', folder: 'secret', tags: ['trashonly'], body: 'x' });
    const idx = buildIndex(
      [file(a.id, a.content), file(b.id, b.content), file(c.id, moveToTrash(c.content))],
      JSON.stringify({ version: 1, folders: ['personal/reading', '_trash/x'] }),
      { commit: 'abc', now: new Date('2026-10-23T10:45:30Z') },
    );
    expect(idx.commit).toBe('abc');
    expect(idx.generatedAt).toBe('2026-10-23T10:45:30.000Z');
    expect(idx.folders).toEqual(['personal', 'personal/reading', 'work', 'work/network', 'work/network/testing']);
    expect(idx.tags).toEqual({ gnmi: 2, ondatra: 1 });
    expect(idx.notes).toHaveLength(3);
    const na = idx.notes.find((n: { id: string }) => n.id === a.id)!;
    expect(na).toMatchObject({ path: `notes/${a.id}.md`, title: 'A', links: ['01JB3K8W2M9X7QZ4R6T1V5N0PB'], sha: blobSha(Buffer.from(a.content)) });
    expect(typeof na.created).toBe('string');
    expect(idx.notes.find((n: { id: string }) => n.id === c.id)!.folder).toBe('_trash');
  });

  it('front matter が壊れたファイルはエラー付きで残す', () => {
    const idx = buildIndex([file('01JB3K8W2M9X7QZ4R6T1V5N0PA', '---\ntitle: [\n---\nbody')], null);
    expect(idx.notes[0].id).toBe('01JB3K8W2M9X7QZ4R6T1V5N0PA');
    expect((idx.notes[0] as { error?: string }).error).toBeTruthy();
  });

  it('blob SHA は git と一致する', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(blobSha(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});
