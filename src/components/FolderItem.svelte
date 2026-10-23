<script lang="ts">
  import Self from './FolderItem.svelte';
  import { app } from '../lib/app.svelte';
  import { createFolder, deleteFolder, renameFolder } from '../lib/actions';
  import type { FolderNode } from '../lib/domain/tree';
  import { longpress, menu } from '../lib/menu.svelte';
  import { loadUi, saveUi } from '../lib/platform/theme';
  import { href, router } from '../lib/router.svelte';
  import { NOTE_MIME } from '../lib/dnd';

  /** unfiled: ツリー先頭の「未分類」（folder が空のノート）。メニューは出さない */
  let { node, depth, unfiled = false }: { node: FolderNode; depth: number; unfiled?: boolean } = $props();

  // 開閉状態は UI 状態なのでリポジトリではなく localStorage に置く
  const isOpen = () => loadUi<Record<string, boolean>>('folders.open', {})[node.path] ?? false;
  let open = $state(isOpen());
  function toggle() {
    open = !open;
    const all = loadUi<Record<string, boolean>>('folders.open', {});
    all[node.path] = open;
    saveUi('folders.open', all);
  }

  const active = $derived(
    unfiled ? router.route.name === 'unfiled' : router.route.name === 'folder' && router.route.path === node.path,
  );

  // 配下のフォルダを開いた時（サブフォルダ作成直後など）は親を展開して見えるようにする
  $effect(() => {
    const r = router.route;
    if (!open && r.name === 'folder' && r.path.startsWith(node.path + '/')) toggle();
  });
  let dropping = $state(false);

  function showMenu(x: number, y: number) {
    if (unfiled) return;
    menu.open(x, y, [
      { label: 'サブフォルダを作成', run: () => createFolder(node.path) },
      { label: 'リネーム・移動', run: () => renameFolder(node.path) },
      { label: '削除', danger: true, run: () => deleteFolder(node.path) },
    ]);
  }

  // PC ではノートをドラッグ＆ドロップで移動
  function onDrop(e: DragEvent) {
    dropping = false;
    const id = e.dataTransfer?.getData(NOTE_MIME);
    if (!id) return;
    e.preventDefault();
    void app.engine.moveNote(id, node.path).then(
      () => app.notify(`${node.path || '未分類'} へ移動しました`),
      (err) => app.notify(err.message),
    );
  }
</script>

<div
  class="item"
  class:active
  class:dropping
  style:padding-left="{0.4 + depth * 0.9}em"
  role="treeitem"
  aria-selected={active}
  aria-expanded={node.children.length ? open : undefined}
  tabindex="-1"
  ondragover={(e) => {
    if (e.dataTransfer?.types.includes(NOTE_MIME)) {
      e.preventDefault();
      dropping = true;
    }
  }}
  ondragleave={() => (dropping = false)}
  ondrop={onDrop}
  use:longpress={showMenu}
>
  <button class="twisty ghost" class:hidden={!node.children.length} onclick={toggle} aria-label={open ? '閉じる' : '開く'}>
    {open ? '▾' : '▸'}
  </button>
  <a href={unfiled ? href({ name: 'unfiled', tags: [] }) : href({ name: 'folder', path: node.path, tags: [] })} title={node.path || node.name}
    >{node.name}</a
  >
  <!-- 直下件数 / 配下合計件数 -->
  <span class="count" title="直下 {node.direct} 件 / 配下合計 {node.total} 件">
    {node.direct}{#if node.total !== node.direct}<span class="total">/{node.total}</span>{/if}
  </span>
</div>
{#if open}
  {#each node.children as child (child.path)}
    <Self node={child} depth={depth + 1} />
  {/each}
{/if}

<style>
  .item {
    display: flex;
    align-items: center;
    gap: 0.1em;
    padding-right: 0.9em;
  }
  .item:hover {
    background: var(--bg-hover);
  }
  .item.active {
    background: var(--bg-active);
  }
  .item.active a {
    color: var(--accent);
  }
  .item.dropping {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }
  .twisty {
    min-height: 0;
    width: 1.6em;
    padding: 0.2em 0;
    color: var(--fg-faint);
    font-size: 0.8em;
  }
  .twisty.hidden {
    visibility: hidden;
  }
  a {
    flex: 1;
    min-width: 0;
    color: var(--fg);
    text-decoration: none;
    padding: 0.25em 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: var(--fg-faint);
    font-size: 0.8em;
  }
  .total {
    opacity: 0.7;
  }
</style>
