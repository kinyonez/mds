import { describe, expect, it } from 'vitest';
import { createNoteContent, parseNote, updateBody, updateMeta } from '../src/lib/domain/note';
import { openDb, Store } from '../src/lib/store/db';
import { Queue } from '../src/lib/store/queue';
import { GitHubClient } from '../src/lib/sync/github';
import { SyncEngine } from '../src/lib/sync/sync';
import { FakeGitHub } from './fakeGithub';

let dbSeq = 0;

async function setup(gh = new FakeGitHub()) {
  const db = await openDb(`test-${++dbSeq}`);
  const store = new Store(db);
  const queue = new Queue(db);
  const clock = { t: Date.UTC(2026, 9, 23, 10, 0, 0) };
  const timers: { fn: () => void; at: number }[] = [];
  const client = new GitHubClient('tok', { owner: 'me', repo: 'notes-data', branch: 'main' }, gh.fetch);
  const engine = new SyncEngine(store, queue, client, {
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock.t + ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  /** 時計を進めて、期限の来たタイマーを発火させる */
  const advance = async (ms: number) => {
    clock.t += ms;
    for (const t of timers.splice(0).filter((x) => x.at <= clock.t)) t.fn();
    await engine.flush();
  };
  return { gh, store, queue, engine, clock, advance, client };
}

const body = (c: string | undefined) => (c ? parseNote(c).body : undefined);

/** リモートにノートを置き、ローカルに取得済みの状態にする */
async function seeded(text: string) {
  const env = await setup();
  const { id, content } = createNoteContent({ title: 'メモ', folder: 'work', tags: ['a'], body: text });
  env.gh.write(`notes/${id}.md`, content);
  await env.engine.fetchNote(id);
  return { ...env, id, content };
}

describe('同期エンジン: 必須 5 シナリオ', () => {
  it('正常保存: 新規作成と更新が楽観ロック付きで PUT される', async () => {
    const { gh, engine, store } = await setup();
    const id = await engine.createNote({ folder: 'work', tags: ['x'], title: '最初', body: 'hello' });
    await engine.flush();
    expect(body(gh.read(`notes/${id}.md`))).toBe('hello');
    expect(gh.head.message).toBe('note: 作成 最初');
    expect((await store.getNote(id))!.dirty).toBe(false);
    expect((await store.getBase(id))!.sha).toBe(gh.sha(`notes/${id}.md`));

    const cur = (await store.getNote(id))!;
    await engine.saveNote(id, updateBody(cur.content, 'hello\nworld'));
    await engine.flush();
    expect(body(gh.read(`notes/${id}.md`))).toBe('hello\nworld');
    expect(gh.head.message).toBe('note: 更新 最初');
    const put = gh.requests.filter((r) => r.method === 'PUT');
    expect(put).toHaveLength(2);
    expect(await engine.noteStatus(id)).toBe('synced');
  });

  it('sha 不一致 → 自動マージ: 異なる行の変更は統合される', async () => {
    const { gh, engine, store, id, content } = await seeded('line1\nline2\nline3');
    // 別デバイスが 1 行目とタグを変更
    gh.write(`notes/${id}.md`, updateMeta(updateBody(content, 'LINE1\nline2\nline3'), { tags: ['a', 'remote'] }));
    // こちらは 3 行目とタグを変更
    const local = updateMeta(updateBody(content, 'line1\nline2\nLINE3'), { tags: ['a', 'local'] });
    await engine.saveNote(id, local);
    await engine.flush();

    const merged = parseNote(gh.read(`notes/${id}.md`)!);
    expect(merged.body).toBe('LINE1\nline2\nLINE3');
    expect(merged.meta.tags!.sort()).toEqual(['a', 'local', 'remote']);
    const rec = (await store.getNote(id))!;
    expect(rec.dirty).toBe(false);
    expect(rec.conflict).toBeUndefined();
    expect(rec.content).toBe(gh.read(`notes/${id}.md`));
  });

  it('sha 不一致 → 競合: 同じ行は自動解決せず、選択後に反映される', async () => {
    const { gh, engine, store, queue, id, content } = await seeded('same line');
    gh.write(`notes/${id}.md`, updateBody(content, 'remote edit'));
    const remoteContent = gh.read(`notes/${id}.md`)!;
    await engine.saveNote(id, updateBody(content, 'local edit'));
    await engine.flush();

    // 黙って新しい方を選ばない
    expect(gh.read(`notes/${id}.md`)).toBe(remoteContent);
    const rec = (await store.getNote(id))!;
    expect(rec.conflict?.content).toBe(remoteContent);
    expect(await engine.noteStatus(id)).toBe('conflict');
    expect(await queue.count()).toBe(0);

    // 「ローカルを採用」
    await engine.resolveConflict(id, 'local');
    await engine.flush();
    expect(body(gh.read(`notes/${id}.md`))).toBe('local edit');
    expect(await engine.noteStatus(id)).toBe('synced');
  });

  it('競合 → 「ローカルを別ノートとして保存」は両方を残す', async () => {
    const { gh, engine, store, id, content } = await seeded('same line');
    gh.write(`notes/${id}.md`, updateBody(content, 'remote edit'));
    await engine.saveNote(id, updateBody(content, 'local edit'));
    await engine.flush();
    const copy = await engine.resolveConflict(id, 'copy');
    await engine.flush();
    expect(body(gh.read(`notes/${id}.md`))).toBe('remote edit');
    expect(body(gh.read(`notes/${copy}.md`))).toBe('local edit');
    expect((await store.getNote(id))!.content).toBe(gh.read(`notes/${id}.md`));
  });

  it('オフライン中の編集が復帰後に流れる', async () => {
    const { gh, engine, store, queue, id, content } = await seeded('a');
    engine.setOnline(false);
    await engine.saveNote(id, updateBody(content, 'offline 1'));
    const second = await engine.createNote({ title: 'オフライン作成', body: 'x' });
    await engine.flush();
    expect(gh.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(await queue.count()).toBe(2);
    expect(await engine.noteStatus(id)).toBe('offline');

    // 送信キューは IndexedDB に永続化されている: エンジンを作り直しても残る
    const engine2 = new SyncEngine(store, new Queue(store.db), engine.getClient(), { now: () => Date.now() });
    await engine2.loadCache();
    expect(engine2.state.pending).toBe(2);

    engine.setOnline(true);
    await engine.flush();
    expect(body(gh.read(`notes/${id}.md`))).toBe('offline 1');
    expect(body(gh.read(`notes/${second}.md`))).toBe('x');
    expect(await queue.count()).toBe(0);
  });

  it('ネットワークエラーは指数バックオフで再試行する', async () => {
    const { gh, engine, queue, advance, id, content } = await setup().then(async (env) => {
      const { id, content } = createNoteContent({ body: 'a' });
      return { ...env, id, content };
    });
    gh.failures.push('network', { status: 502 });
    await engine.saveNote(id, content);
    await engine.flush();
    let [item] = await queue.all();
    expect(item.attempts).toBe(1);
    await advance(9_000);
    expect((await queue.all())[0].attempts).toBe(1); // まだ 10 秒経っていない
    await advance(1_000);
    [item] = await queue.all();
    expect(item.attempts).toBe(2); // 502
    await advance(20_000);
    expect(await queue.count()).toBe(0);
    expect(gh.read(`notes/${id}.md`)).toBe(content);
  });

  it('レート制限からの復帰: X-RateLimit-Reset まで待って自動再開する', async () => {
    const { gh, engine, queue, clock, advance } = await setup();
    const reset = Math.floor(clock.t / 1000) + 120;
    gh.failures.push({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
    const id = await engine.createNote({ body: 'rate' });
    await engine.flush();
    expect(engine.state.paused?.reason).toBe('ratelimit');
    expect(engine.state.paused?.until).toBe(reset * 1000);
    expect(await queue.count()).toBe(1);

    await advance(60_000);
    expect(await queue.count()).toBe(1);
    await advance(60_000);
    expect(engine.state.paused).toBeNull();
    expect(await queue.count()).toBe(0);
    expect(body(gh.read(`notes/${id}.md`))).toBe('rate');
  });
});

describe('同期エンジン: エラー・一括コミット', () => {
  it('401 はキューを止め、ローカルの編集を保持する', async () => {
    const { gh, engine, queue, store } = await setup();
    gh.failures.push({ status: 401 });
    const id = await engine.createNote({ body: 'keep me' });
    await engine.flush();
    expect(engine.state.paused?.reason).toBe('auth');
    expect(await queue.count()).toBe(1);
    expect((await store.getNote(id))!.dirty).toBe(true);
  });

  it('フォルダのリネームは配下全ノートと folders.json を 1 コミットで書き換える', async () => {
    const { gh, engine, store } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { id, content } = createNoteContent({ title: `n${i}`, folder: i % 2 ? 'work/net' : 'work', body: String(i) });
      gh.write(`notes/${id}.md`, content);
      ids.push(id);
    }
    const other = createNoteContent({ folder: 'workshop', body: 'not me' });
    gh.write(`notes/${other.id}.md`, other.content);
    gh.write('_meta/folders.json', JSON.stringify({ version: 1, folders: ['work/empty'] }));
    gh.write('index.json', fakeIndex(gh));
    await engine.refreshIndex();

    const before = gh.commits.length;
    const n = await engine.renameFolder('work', 'job');
    await engine.flush();
    expect(n).toBe(12);
    expect(gh.commits.length).toBe(before + 1);
    expect(gh.head.message).toBe('folder: リネーム work → job');
    for (const [i, id] of ids.entries()) {
      expect(parseNote(gh.read(`notes/${id}.md`)!).meta.folder).toBe(i % 2 ? 'job/net' : 'job');
      expect((await store.getNote(id))!.dirty).toBe(false);
    }
    expect(parseNote(gh.read(`notes/${other.id}.md`)!).meta.folder).toBe('workshop');
    expect(JSON.parse(gh.read('_meta/folders.json')!).folders).toEqual(['job/empty']);
    expect(await engine.folderSet()).not.toContain('work/empty');
  });

  it('一括コミット中に他デバイスが変えたノートは外して、通常のマージ経路に回す', async () => {
    const { gh, engine } = await setup();
    const a = createNoteContent({ folder: 'x', tags: ['old'], body: 'a' });
    const b = createNoteContent({ folder: 'x', tags: ['old'], body: 'b1\nb2' });
    gh.write(`notes/${a.id}.md`, a.content);
    gh.write(`notes/${b.id}.md`, b.content);
    gh.write('index.json', fakeIndex(gh));
    await engine.refreshIndex();
    await engine.fetchNote(a.id);
    await engine.fetchNote(b.id);
    engine.setOnline(false);
    await engine.renameTag('old', 'new').catch(() => 0);
    // 他デバイスが b の本文を変える
    gh.write(`notes/${b.id}.md`, updateBody(b.content, 'b1\nB2'));
    engine.setOnline(true);
    await engine.flush();
    await engine.flush();
    expect(parseNote(gh.read(`notes/${a.id}.md`)!).meta.tags).toEqual(['new']);
    const pb = parseNote(gh.read(`notes/${b.id}.md`)!);
    expect(pb.meta.tags).toEqual(['new']);
    expect(pb.body).toBe('b1\nB2');
  });

  it('ゴミ箱 → 完全削除で本文と添付を一括で消す', async () => {
    const { gh, engine, store } = await seeded('bye');
    const id = (await store.allNotes())[0].id;
    gh.write(`attachments/${id}/img.png`, 'PNG');
    await engine.trashNote(id);
    await engine.flush();
    const trashed = parseNote(gh.read(`notes/${id}.md`)!);
    expect(trashed.meta.folder).toBe('_trash');
    expect(trashed.meta.trashedFrom).toBe('work');
    expect(gh.head.message).toBe('note: ゴミ箱へ メモ');

    await engine.restoreNote(id);
    await engine.flush();
    const restored = parseNote(gh.read(`notes/${id}.md`)!);
    expect(restored.meta.folder).toBe('work');
    expect(restored.meta.trashedFrom).toBeUndefined();

    await engine.trashNote(id);
    await engine.purgeNotes([id]);
    await engine.flush();
    expect(gh.read(`notes/${id}.md`)).toBeUndefined();
    expect(gh.read(`attachments/${id}/img.png`)).toBeUndefined();
    expect((await engine.summaries()).find((n) => n.id === id)).toBeUndefined();
  });

  it('空フォルダの作成は folders.json に和集合で追加される', async () => {
    const { gh, engine } = await setup();
    gh.write('_meta/folders.json', JSON.stringify({ version: 1, folders: ['remote/only'] }));
    await engine.createFolder(' local / new ');
    await engine.flush();
    expect(JSON.parse(gh.read('_meta/folders.json')!).folders).toEqual(['local/new', 'remote/only']);
    expect(await engine.folderSet()).toContain('local/new');
  });

  it('index のラグ中は自分の変更をローカルのメタデータで補う', async () => {
    const { gh, engine, clock, id } = await seeded('x');
    gh.write('index.json', fakeIndex(gh, new Date(clock.t - 1000).toISOString()));
    await engine.refreshIndex();
    await engine.moveNote(id, 'moved');
    await engine.flush();
    // index.json はまだ古い
    const s = (await engine.summaries()).find((n) => n.id === id)!;
    expect(s.folder).toBe('moved');
    expect(gh.head.message).toBe('note: 移動 メモ → moved');

    // 他デバイスが後から変更し、それを含む index が来たら index を優先する
    const remote = gh.read(`notes/${id}.md`)!;
    gh.write(`notes/${id}.md`, updateMeta(remote, { folder: 'elsewhere' }));
    clock.t += 60_000;
    gh.write('index.json', fakeIndex(gh, new Date(clock.t).toISOString()));
    await engine.refreshIndex();
    expect((await engine.summaries()).find((n) => n.id === id)!.folder).toBe('elsewhere');
  });

  it('index の sha が変わったノートは開いた時に取り直す', async () => {
    const { gh, engine, id, content } = await seeded('v1');
    gh.write(`notes/${id}.md`, updateBody(content, 'v2'));
    gh.write('index.json', fakeIndex(gh));
    await engine.refreshIndex();
    expect(await engine.isStale(id)).toBe(true);
    const rec = await engine.openNote(id);
    expect(body(rec!.content)).toBe('v2');
    // 304 なら何もしない
    expect(await engine.refreshIndex()).toBe(false);
  });
});

function fakeIndex(gh: FakeGitHub, generatedAt?: string): string {
  const notes = [...gh.files().keys()]
    .filter((p) => p.startsWith('notes/'))
    .map((p) => {
      const { meta, body } = parseNote(gh.read(p)!);
      return { ...meta, path: p, sha: gh.sha(p), excerpt: body.slice(0, 200), links: [] };
    });
  return JSON.stringify({ version: 1, generatedAt, folders: [], tags: {}, notes });
}

describe('デバウンス', () => {
  it('enqueue: false はローカル保存だけでキューに積まない', async () => {
    const { gh, engine, queue, store } = await setup();
    const { id, content } = createNoteContent({ body: 'typing' });
    await engine.saveNote(id, content, { enqueue: false });
    expect((await store.getNote(id))!.dirty).toBe(true);
    expect(await queue.count()).toBe(0);
    expect(await engine.noteStatus(id)).toBe('local');
    // 同じ内容でも、未送信なら閉じた時点で積む
    await engine.saveNote(id, content);
    await engine.flush();
    expect(gh.read(`notes/${id}.md`)).toBe(content);
  });
});

describe('手動モード', () => {
  it('編集・定期同期ではコミットせず、commitNow でまとめて 1 コミットにする', async () => {
    const { gh, engine, store, queue } = await seeded('base');
    await engine.setMode('manual');
    const id = (await store.allNotes())[0].id;
    const before = gh.commits.length;

    const cur = (await store.getNote(id))!;
    await engine.saveNote(id, updateBody(cur.content, 'edited'));
    const a = await engine.createNote({ title: '新規 A', body: 'a' });
    const b = await engine.createNote({ title: '新規 B', body: 'b', folder: 'x' });
    await engine.createFolder('empty/folder');
    await engine.addAttachment(a, 'img.png', new Blob([new Uint8Array([1, 2, 3])]));
    await engine.flush();
    await engine.sync(); // 定期同期は pull だけ
    expect(gh.commits.length).toBe(before);
    expect(await queue.count()).toBe(0);
    expect(engine.state.changes).toBe(5); // ノート 3 + 添付 1 + folders.json 1
    expect(await engine.noteStatus(a)).toBe('local');

    await engine.commitNow();
    expect(gh.commits.length).toBe(before + 1);
    expect(gh.head.message).toMatch(/^sync: 5 件の変更\n\n- note: 更新 メモ\n/);
    expect(body(gh.read(`notes/${id}.md`))).toBe('edited');
    expect(body(gh.read(`notes/${a}.md`))).toBe('a');
    expect(parseNote(gh.read(`notes/${b}.md`)!).meta.folder).toBe('x');
    expect(JSON.parse(gh.read('_meta/folders.json')!).folders).toEqual(['empty/folder']);
    expect([...gh.files().keys()].some((p) => p.startsWith(`attachments/${a}/`))).toBe(true);
    expect(engine.state.changes).toBe(0);
    expect(await engine.noteStatus(a)).toBe('synced');

    // その後の編集も、commitNow までは溜まる
    await engine.saveNote(a, updateBody((await store.getNote(a))!.content, 'a2'));
    await engine.commitNow();
    expect(gh.commits.length).toBe(before + 2);
    expect(gh.head.message).toBe('note: 更新 新規 A');
  });

  it('リネームと完全削除も 1 コミットに含まれる', async () => {
    const { gh, engine } = await setup();
    const n1 = createNoteContent({ title: 'n1', folder: 'old', tags: ['t'], body: '1' });
    const n2 = createNoteContent({ title: 'n2', folder: 'old', body: '2' });
    gh.write(`notes/${n1.id}.md`, n1.content);
    gh.write(`notes/${n2.id}.md`, n2.content);
    gh.write(`attachments/${n2.id}/x.png`, 'PNG');
    gh.write('index.json', fakeIndex(gh));
    await engine.refreshIndex();
    await engine.setMode('manual');
    const before = gh.commits.length;

    await engine.renameFolder('old', 'new');
    await engine.renameTag('t', 'u');
    await engine.trashNote(n2.id);
    await engine.purgeNotes([n2.id]);
    await engine.flush();
    expect(gh.commits.length).toBe(before);

    await engine.commitNow();
    expect(gh.commits.length).toBe(before + 1);
    const p1 = parseNote(gh.read(`notes/${n1.id}.md`)!);
    expect(p1.meta.folder).toBe('new');
    expect(p1.meta.tags).toEqual(['u']);
    expect(gh.read(`notes/${n2.id}.md`)).toBeUndefined();
    expect(gh.read(`attachments/${n2.id}/x.png`)).toBeUndefined();
    expect(engine.state.changes).toBe(0);
  });

  it('他デバイスと食い違ったノートはマージしてから送る', async () => {
    const { gh, engine, id, content } = await seeded('l1\nl2\nl3');
    await engine.setMode('manual');
    gh.write(`notes/${id}.md`, updateBody(content, 'L1\nl2\nl3'));
    await engine.saveNote(id, updateBody(content, 'l1\nl2\nL3'));
    await engine.commitNow();
    expect(body(gh.read(`notes/${id}.md`))).toBe('L1\nl2\nL3');
    expect(engine.state.changes).toBe(0);
  });

  it('手動 → 自動に切り替えると溜まった変更を 1 コミットで送る', async () => {
    const { gh, engine } = await setup();
    await engine.setMode('manual');
    await engine.createNote({ body: 'x' });
    await engine.createNote({ body: 'y' });
    const before = gh.commits.length;
    await engine.setMode('auto');
    await engine.flush();
    expect(gh.commits.length).toBe(before + 1);
    expect(engine.state.changes).toBe(0);
  });
});
