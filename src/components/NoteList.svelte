<script lang="ts">
  import { app } from '../lib/app.svelte';
  import {
    deleteTemplate,
    editTags,
    emptyTrash,
    moveNotes,
    newNote,
    newNoteFromTemplate,
    purgeNotes,
    restoreNotes,
    trashNotes,
  } from '../lib/actions';
  import { NOTE_MIME } from '../lib/dnd';
  import { isReserved, isTemplate, isTrashed, timeOf } from '../lib/domain/note';
  import { inFolder } from '../lib/domain/tree';
  import type { NoteSummary } from '../lib/domain/types';
  import { longpress, menu } from '../lib/menu.svelte';
  import { href, router, type ListRoute } from '../lib/router.svelte';

  let { onmenu }: { onmenu: () => void } = $props();

  const list = $derived(router.list);
  const openId = $derived(router.route.name === 'note' ? router.route.id : null);
  let query = $state('');
  let dirtyIds = $state(new Set<string>());

  // 未送信のノートに印を付ける
  $effect(() => {
    void app.sync?.version;
    void app.store.allNotes().then((rs) => (dirtyIds = new Set(rs.filter((r) => r.dirty || r.conflict).map((r) => r.id))));
  });

  const title = $derived.by(() => {
    switch (list.name) {
      case 'folder':
        return list.path;
      case 'unfiled':
        return '未分類';
      case 'tag':
        return `#${list.tag}`;
      case 'trash':
        return 'ゴミ箱';
      case 'templates':
        return 'テンプレート';
      default:
        return 'すべてのノート';
    }
  });

  function matches(n: NoteSummary, l: ListRoute): boolean {
    // ゴミ箱・テンプレートはそれぞれのビューの中だけで扱う（検索もデフォルトで除外）
    if (l.name === 'trash') {
      if (!isTrashed(n)) return false;
    } else if (l.name === 'templates') {
      if (!isTemplate(n)) return false;
    } else if (isReserved(n)) return false;
    if (l.name === 'folder' && !inFolder(n, l.path, true)) return false;
    if (l.name === 'unfiled' && n.folder !== '') return false;
    if (l.name === 'tag' && !n.tags.includes(l.tag)) return false;
    // 複数タグは AND
    return l.tags.every((t) => n.tags.includes(t));
  }

  /** リスト / パネル表示の切り替えは通常の一覧だけ（ゴミ箱・テンプレートはリスト固定） */
  const switchable = $derived(list.name !== 'trash' && list.name !== 'templates');
  const panel = $derived(switchable && app.listView === 'panel');

  const notes = $derived.by(() => {
    const base = app.notes.filter((n) => matches(n, list));
    if (list.name === 'templates' && !query.trim()) return base.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
    if (!query.trim()) return base.sort((a, b) => timeOf(b.updated) - timeOf(a.updated));
    const order = new Map(app.searchIds(query).map((id, i) => [id, i]));
    return base.filter((n) => order.has(n.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  });

  /** 絞り込みに追加できるタグ（今の一覧に出ているノートのタグ） */
  const addableTags = $derived(
    [...new Set(notes.flatMap((n) => n.tags))].filter((t) => !list.tags.includes(t) && !(list.name === 'tag' && list.tag === t)).sort(),
  );

  function withTags(tags: string[]): ListRoute {
    return { ...list, tags } as ListRoute;
  }

  function fmt(iso: string): string {
    const t = timeOf(iso);
    if (!t) return '';
    const d = new Date(t);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('ja-JP', { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'numeric', day: 'numeric' });
  }

  function templateMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.open(r.left, r.bottom + 4, [
      { label: '空のノート', run: () => newNote(list) },
      ...app.templates.map((t) => ({ label: `📄 ${t.title}`, run: () => newNoteFromTemplate(t.id, list) })),
      { label: 'テンプレートを管理…', run: () => router.go({ name: 'templates', tags: [] }) },
    ]);
  }

  function showMenu(n: NoteSummary, x: number, y: number) {
    if (list.name === 'templates') {
      menu.open(x, y, [
        { label: 'このテンプレートでノートを作成', run: () => newNoteFromTemplate(n.id, router.list) },
        { label: '削除', danger: true, run: () => deleteTemplate(n.id, n.title) },
      ]);
      return;
    }
    if (list.name === 'trash') {
      menu.open(x, y, [
        { label: '復元', run: () => restoreNotes([n.id]) },
        { label: '完全に削除', danger: true, run: () => purgeNotes([n.id]) },
      ]);
      return;
    }
    menu.open(x, y, [
      { label: '移動', run: () => moveNotes([n.id], n.folder) },
      { label: 'タグ付け', run: () => editTags(n.id, n.tags) },
      { label: 'ゴミ箱へ', danger: true, run: () => trashNotes([n.id]) },
    ]);
  }
</script>

<header>
  <button class="ghost menu-btn" onclick={onmenu} aria-label="サイドバーを開く">☰</button>
  <h1 title={title}>{title}</h1>
  {#if list.name === 'trash'}
    <button class="small" onclick={emptyTrash} title="trashedAt から 30 日経過したものをまとめて削除">空にする</button>
  {:else}
    {#if app.manual && app.unsynced > 0 && app.sync?.configured}
      <button onclick={() => app.syncNow()} disabled={app.sync?.syncing} title="未コミットの変更をまとめて 1 コミットにする">
        {app.sync?.syncing ? '同期中…' : `同期 (${app.unsynced})`}
      </button>
    {/if}
    {#if list.name === 'templates'}
      <button class="primary" onclick={() => newNote(list)} aria-label="新規テンプレート">＋ 新規</button>
    {:else}
      <span class="split">
        <button class="primary" onclick={() => newNote(list)} aria-label="新規ノート">＋ 新規</button>
        {#if app.templates.length}
          <button class="primary caret" onclick={templateMenu} aria-label="テンプレートから作成" title="テンプレートから作成">▾</button>
        {/if}
      </span>
    {/if}
  {/if}
</header>

<div class="tools">
  <div class="search-row">
    <input type="search" placeholder={list.name === 'trash' ? 'ゴミ箱を検索' : list.name === 'templates' ? 'テンプレートを検索' : '検索'} bind:value={query} />
    {#if switchable}
      <div class="view-toggle" role="group" aria-label="表示">
        <button class:on={!panel} onclick={() => app.setListView('list')} aria-label="リスト表示" title="リスト">☰</button>
        <button class:on={panel} onclick={() => app.setListView('panel')} aria-label="パネル表示" title="パネル">▦</button>
      </div>
    {/if}
  </div>
  {#if list.name === 'templates'}
    <p class="hint small muted">
      テンプレートの本文・タイトル・フォルダ・タグが新しいノートの初期値になります。本文とタイトルでは
      <code>{'{{date}}'}</code> <code>{'{{time}}'}</code> <code>{'{{title}}'}</code> が使えます。
    </p>
  {/if}
  {#if list.tags.length || addableTags.length}
    <div class="filters">
      {#each list.tags as t (t)}
        <a class="chip" href={href(withTags(list.tags.filter((x) => x !== t)))} title="絞り込みを外す">#{t} ×</a>
      {/each}
      {#if addableTags.length}
        <select
          aria-label="タグで絞り込み"
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            if (v) router.go(withTags([...list.tags, v]));
            (e.currentTarget as HTMLSelectElement).value = '';
          }}
        >
          <option value="">＋ タグで絞り込み</option>
          {#each addableTags as t (t)}<option value={t}>#{t}</option>{/each}
        </select>
      {/if}
    </div>
  {/if}
</div>

<ul class="notes" class:panel>
  {#each notes as n (n.id)}
    <li>
      <a
        href={href({ name: 'note', id: n.id })}
        class:active={openId === n.id}
        draggable="true"
        ondragstart={(e) => {
          e.dataTransfer?.setData(NOTE_MIME, n.id);
          e.dataTransfer!.effectAllowed = 'move';
        }}
        use:longpress={(x, y) => showMenu(n, x, y)}
      >
        <div class="top">
          <span class="title">{n.title}</span>
          {#if dirtyIds.has(n.id)}<span class="unsynced" title="未同期">●</span>{/if}
          <span class="date">{fmt(n.updated)}</span>
        </div>
        {#if n.error}
          <div class="error small">⚠ {n.error}</div>
        {:else if n.excerpt}
          <div class="excerpt">{n.excerpt}</div>
        {/if}
        <div class="meta">
          {#if list.name !== 'folder' && n.folder && !isReserved(n)}<span class="folder">{n.folder}</span>{/if}
          {#if list.name === 'trash' && n.trashedFrom !== undefined}<span class="folder">元: {n.trashedFrom || '未分類'}</span>{/if}
          {#each n.tags as t (t)}<span class="tag">#{t}</span>{/each}
        </div>
      </a>
    </li>
  {:else}
    <li class="empty muted">
      {query ? '一致するノートはありません' : list.name === 'templates' ? 'テンプレートはありません。「＋ 新規」から作成できます' : 'ノートはありません'}
    </li>
  {/each}
</ul>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 0.5em;
    padding: 0.5em 0.8em;
    border-bottom: 1px solid var(--border);
  }
  h1 {
    flex: 1;
    margin: 0;
    font-size: 1em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-btn {
    display: none;
    font-size: 1.1em;
  }
  .split {
    display: inline-flex;
  }
  .split button:first-child:not(:last-child) {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .caret {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: 1px solid rgba(255, 255, 255, 0.4);
    padding: 0.35em 0.5em;
  }
  .search-row {
    display: flex;
    gap: 0.4em;
  }
  .view-toggle {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    flex-shrink: 0;
  }
  .view-toggle button {
    border: none;
    border-radius: 0;
    background: none;
    padding: 0 0.6em;
    color: var(--fg-muted);
  }
  .view-toggle button.on {
    background: var(--bg-active);
    color: var(--accent);
  }
  .hint {
    margin: 0;
  }
  .hint code {
    font-family: var(--mono);
    font-size: 0.95em;
  }
  /* パネル表示 */
  .notes.panel {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 0.8em;
    padding: 0.8em 0.8em calc(0.8em + env(safe-area-inset-bottom, 0px));
    align-content: start;
  }
  .notes.panel a {
    height: 100%;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    gap: 0.3em;
    min-height: 140px;
  }
  .notes.panel a:hover {
    border-color: var(--accent);
  }
  .notes.panel a.active {
    border-color: var(--accent);
    background: var(--bg-active);
  }
  .notes.panel .top {
    flex-direction: column;
    gap: 0;
  }
  .notes.panel .title {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    width: 100%;
  }
  .notes.panel .date {
    order: 3;
  }
  .notes.panel .excerpt {
    flex: 1;
    -webkit-line-clamp: 6;
    line-clamp: 6;
  }
  .notes.panel .empty {
    grid-column: 1 / -1;
  }
  @media (max-width: 899px) {
    .notes.panel {
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 0.6em;
      padding: 0.6em;
    }
  }
  @media (max-width: 899px) {
    .menu-btn {
      display: inline-block;
    }
  }
  .tools {
    padding: 0.5em 0.8em;
    display: flex;
    flex-direction: column;
    gap: 0.4em;
    border-bottom: 1px solid var(--border);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3em;
    align-items: center;
  }
  .filters a {
    text-decoration: none;
  }
  .filters select {
    width: auto;
    min-height: 26px;
    padding: 0 0.4em;
    font-size: 0.8em;
  }
  .notes {
    list-style: none;
    margin: 0;
    padding: 0 0 env(safe-area-inset-bottom, 0px);
    overflow-y: auto;
    flex: 1;
  }
  .notes a {
    display: block;
    padding: 0.6em 0.9em;
    border-bottom: 1px solid var(--border);
    color: var(--fg);
    text-decoration: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .notes a:hover {
    background: var(--bg-hover);
  }
  .notes a.active {
    background: var(--bg-active);
  }
  .top {
    display: flex;
    gap: 0.4em;
    align-items: baseline;
  }
  .title {
    flex: 1;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unsynced {
    color: var(--conflict);
    font-size: 0.7em;
  }
  .date {
    color: var(--fg-faint);
    font-size: 0.8em;
    white-space: nowrap;
  }
  .excerpt {
    color: var(--fg-muted);
    font-size: 0.85em;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .error {
    color: var(--danger);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4em;
    font-size: 0.75em;
    color: var(--fg-faint);
    margin-top: 0.15em;
  }
  .tag {
    color: var(--accent);
  }
  .empty {
    padding: 2em 1em;
    text-align: center;
  }
</style>
