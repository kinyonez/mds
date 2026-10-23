<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { createFolder, renameTag } from '../lib/actions';
  import { longpress } from '../lib/menu.svelte';
  import { router } from '../lib/router.svelte';
  import FolderItem from './FolderItem.svelte';
  import SyncBadge from './SyncBadge.svelte';

  let { onclose }: { onclose: () => void } = $props();

  const r = $derived(router.route);
  const unfiled = $derived(app.notes.filter((n) => n.folder === '').length);
  const active = (name: string, extra?: string) =>
    r.name === name && (extra === undefined || ('path' in r && r.path === extra) || ('tag' in r && r.tag === extra));
</script>

<header>
  <strong>mds</strong>
  <SyncBadge />
  <span class="spacer"></span>
  <a class="icon" href="#/settings" title="設定" aria-label="設定">⚙</a>
  <button class="ghost close" onclick={onclose} aria-label="閉じる">×</button>
</header>

<nav>
  <a class="row" class:active={active('all')} href="#/">
    <span>すべてのノート</span><span class="count">{app.notes.length - app.trashCount}</span>
  </a>
  <!-- folder が空のノートはツリー先頭の「未分類」 -->
  <a class="row" class:active={active('unfiled')} href="#/unfiled">
    <span>未分類</span><span class="count">{unfiled}</span>
  </a>

  <div class="section">
    <span>フォルダ</span>
    <button class="ghost add" title="新しいフォルダ" aria-label="新しいフォルダ" onclick={() => createFolder()}>＋</button>
  </div>
  {#each app.tree.children as node (node.path)}
    <FolderItem {node} depth={0} />
  {:else}
    <p class="muted small empty">フォルダはありません</p>
  {/each}

  <div class="section"><span>タグ</span></div>
  <div class="tags">
    {#each app.tags as [tag, count] (tag)}
      <a
        class="tag"
        class:active={active('tag', tag)}
        href={`#/tag/${encodeURIComponent(tag)}`}
        use:longpress={() => renameTag(tag)}
        title="右クリック / 長押しでリネーム・統合"
      >
        #{tag} <span class="count">{count}</span>
      </a>
    {:else}
      <p class="muted small empty">タグはありません</p>
    {/each}
  </div>
</nav>

<footer>
  <a class="row" class:active={active('trash')} href="#/trash">
    <span>ゴミ箱</span><span class="count">{app.trashCount} 件</span>
  </a>
</footer>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 0.5em;
    padding: 0.6em 0.8em;
    border-bottom: 1px solid var(--border);
  }
  .spacer {
    flex: 1;
  }
  .icon {
    text-decoration: none;
    color: var(--fg-muted);
    font-size: 1.1em;
    padding: 0 0.2em;
  }
  .close {
    display: none;
  }
  @media (max-width: 899px) {
    .close {
      display: inline-block;
    }
  }
  nav {
    flex: 1;
    overflow-y: auto;
    padding: 0.4em 0;
  }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 0.3em 0.9em;
    color: var(--fg);
    text-decoration: none;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .row.active {
    background: var(--bg-active);
    color: var(--accent);
  }
  .count {
    color: var(--fg-faint);
    font-size: 0.85em;
  }
  .section {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.8em 0.9em 0.2em;
    color: var(--fg-muted);
    font-size: 0.8em;
    font-weight: 600;
  }
  .add {
    min-height: 0;
    padding: 0 0.4em;
  }
  .empty {
    padding: 0 0.9em;
    margin: 0.2em 0;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3em;
    padding: 0.2em 0.9em;
  }
  .tag {
    text-decoration: none;
    color: var(--fg-muted);
    font-size: 0.85em;
    padding: 0.05em 0.5em;
    border-radius: 999px;
    border: 1px solid var(--border);
    -webkit-touch-callout: none;
  }
  .tag.active {
    background: var(--bg-active);
    color: var(--accent);
    border-color: var(--accent);
  }
  footer {
    border-top: 1px solid var(--border);
    padding: 0.3em 0 calc(0.3em + env(safe-area-inset-bottom, 0px));
  }
</style>
