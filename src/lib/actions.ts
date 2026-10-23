import { app } from './app.svelte';
import { dialogs } from './dialog.svelte';
import { TEMPLATES, normalizeFolder, normalizeTags, parseNote } from './domain/note';
import { expandTemplate } from './domain/template';
import { router, type ListRoute } from './router.svelte';

async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    app.notify((e as Error).message);
    return undefined;
  }
}

function listContext(list: ListRoute) {
  return {
    folder: list.name === 'folder' ? list.path : '',
    tags: [...(list.tags ?? []), ...(list.name === 'tag' ? [list.tag] : [])],
  };
}

/** 新規ノートは現在表示中のフォルダとタグ絞り込みを初期値として引き継ぐ */
export async function newNote(list: ListRoute = router.list) {
  if (list.name === 'templates') return newTemplate();
  const id = await guard(() => app.engine.createNote(listContext(list)));
  if (id) router.go({ name: 'note', id });
}

/** テンプレートの本文・タイトル・フォルダ・タグを初期値にしてノートを作る */
export async function newNoteFromTemplate(templateId: string, list: ListRoute = router.list) {
  const id = await guard(async () => {
    const rec = await app.engine.openNote(templateId);
    if (!rec) throw new Error('テンプレートの本文を取得できません（オフラインで未取得の可能性があります）');
    return app.engine.createNote(expandTemplate(parseNote(rec.content, templateId), listContext(list)));
  });
  if (id) router.go({ name: 'note', id });
}

export async function newTemplate() {
  const id = await guard(() => app.engine.createNote({ folder: TEMPLATES, title: '新しいテンプレート' }));
  if (id) router.go({ name: 'note', id });
}

/** テンプレートはゴミ箱を経由せずに削除する */
export async function deleteTemplate(id: string, name: string) {
  const ok = await dialogs.confirm(`テンプレート「${name}」を削除しますか？`, {
    message: 'このテンプレートから作ったノートには影響しません。',
    confirmLabel: '削除',
    danger: true,
  });
  if (!ok) return;
  await guard(() => app.engine.purgeNotes([id]));
  router.go({ name: 'templates', tags: [] });
}

export async function moveNotes(ids: string[], current = '') {
  const dest = await dialogs.pickFolder(ids.length > 1 ? `${ids.length} 件を移動` : '移動先のフォルダ', current);
  if (dest == null) return;
  await guard(async () => {
    const f = normalizeFolder(dest);
    for (const id of ids) await app.engine.moveNote(id, f);
    app.notify(`${f || '未分類'} へ移動しました`);
  });
}

export async function editTags(id: string, current: string[]) {
  const v = await dialogs.prompt('タグ', { value: current.join(', '), message: 'カンマ区切りで入力', confirmLabel: '保存' });
  if (v == null) return;
  await guard(() => app.engine.setTags(id, normalizeTags(v)));
}

export async function trashNotes(ids: string[]) {
  await guard(async () => {
    for (const id of ids) await app.engine.trashNote(id);
    app.notify(`${ids.length} 件をゴミ箱へ移動しました`);
  });
}

export async function restoreNotes(ids: string[]) {
  await guard(async () => {
    for (const id of ids) await app.engine.restoreNote(id);
    app.notify(`${ids.length} 件を復元しました`);
  });
}

export async function purgeNotes(ids: string[]) {
  if (!ids.length) return;
  const ok = await dialogs.confirm(`${ids.length} 件を完全に削除しますか？`, {
    message: '本文と添付ファイルをリポジトリから削除します。履歴からは復元できます。',
    confirmLabel: '完全に削除',
    danger: true,
  });
  if (!ok) return;
  await guard(() => app.engine.purgeNotes(ids));
}

export async function emptyTrash() {
  const ids = await app.engine.expiredTrash(30);
  if (!ids.length) {
    app.notify('30 日以上経過したノートはありません');
    return;
  }
  await purgeNotes(ids);
}

export async function createFolder(parent = '') {
  const v = await dialogs.prompt('新しいフォルダ', { value: parent ? parent + '/' : '', placeholder: 'work/network', confirmLabel: '作成' });
  if (v == null) return;
  await guard(async () => {
    const p = normalizeFolder(v);
    await app.engine.createFolder(p);
    router.go({ name: 'folder', path: p, tags: [] });
  });
}

export async function renameFolder(path: string) {
  const v = await dialogs.prompt('フォルダのリネーム・移動', { value: path, message: 'パスを変更すると配下のフォルダも一緒に移動します', confirmLabel: '次へ' });
  if (v == null) return;
  await guard(async () => {
    const to = normalizeFolder(v);
    if (to === path) return;
    const ids = await app.engine.notesUnderFolder(path);
    // 件数を事前に表示して確認を取る
    const ok = await dialogs.confirm(`${path} → ${to || '(ルート)'}`, {
      message: `配下の ${ids.length} 件のノートを書き換えて、1 つのコミットで保存します。`,
      confirmLabel: '実行',
    });
    if (!ok) return;
    const n = await app.engine.renameFolder(path, to);
    app.notify(`${n} 件を移動しました`);
    if (to) router.go({ name: 'folder', path: to, tags: [] });
    else router.go({ name: 'unfiled', tags: [] });
  });
}

export async function deleteFolder(path: string) {
  const ok = await dialogs.confirm(`フォルダ「${path}」を削除しますか？`, { confirmLabel: '削除', danger: true });
  if (!ok) return;
  const done = await guard(async () => {
    await app.engine.deleteFolder(path);
    return true;
  });
  if (done) router.go({ name: 'all', tags: [] });
}

export async function renameTag(tag: string) {
  const v = await dialogs.prompt('タグのリネーム・統合', {
    value: tag,
    message: '既にあるタグ名にすると統合します（重複は除去）',
    confirmLabel: '次へ',
  });
  if (v == null) return;
  await guard(async () => {
    const [to] = normalizeTags([v]);
    if (!to || to === tag) return;
    const ids = await app.engine.notesWithTag(tag);
    const ok = await dialogs.confirm(`#${tag} → #${to}`, {
      message: `${ids.length} 件のノートを書き換えて、1 つのコミットで保存します。`,
      confirmLabel: '実行',
    });
    if (!ok) return;
    const n = await app.engine.renameTag(tag, to);
    app.notify(`${n} 件のタグを変更しました`);
    router.go({ name: 'tag', tag: to, tags: [] });
  });
}
