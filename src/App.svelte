<script lang="ts">
  import { app } from './lib/app.svelte';
  import { router } from './lib/router.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import NoteList from './components/NoteList.svelte';
  import NoteView from './views/NoteView.svelte';
  import Settings from './views/Settings.svelte';
  import Unlock from './views/Unlock.svelte';
  import Banners from './components/Banners.svelte';
  import DialogHost from './components/DialogHost.svelte';
  import MenuHost from './components/MenuHost.svelte';

  // スマホでは 1 ペインずつ遷移する
  let sidebarOpen = $state(false);
  const pane = $derived(
    sidebarOpen ? 'sidebar' : router.route.name === 'note' || router.route.name === 'settings' ? 'main' : 'list',
  );

  // PC のパネル表示では、ノートを開くまで一覧を右側いっぱいに広げる
  const wideList = $derived(
    app.listView === 'panel' &&
      pane === 'list' &&
      router.list.name !== 'trash' &&
      router.list.name !== 'templates',
  );

  $effect(() => {
    // ルートが変わったらサイドバーを閉じる
    void router.route;
    sidebarOpen = false;
  });

  // 左右スワイプでペイン間を移動
  let touch: { x: number; y: number; t: number } | null = null;
  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0];
    touch = { x: t.clientX, y: t.clientY, t: Date.now() };
  }
  function onTouchEnd(e: TouchEvent) {
    if (!touch || matchMedia('(min-width: 900px)').matches) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    const fast = Date.now() - touch.t < 600;
    touch = null;
    // エディタ内の横スクロールやテキスト選択と衝突しないよう、はっきりした横スワイプだけ拾う
    if (!fast || Math.abs(dx) < 80 || Math.abs(dy) > Math.abs(dx) / 2) return;
    if ((e.target as HTMLElement).closest('.cm-editor, pre, table, input, textarea')) return;
    if (dx > 0) {
      if (pane === 'main') router.go(router.list);
      else if (pane === 'list') sidebarOpen = true;
    } else {
      if (pane === 'sidebar') sidebarOpen = false;
      else if (pane === 'list' && app.lastNote) router.go({ name: 'note', id: app.lastNote });
    }
  }
</script>

{#if app.phase === 'loading'}
  <div class="center muted">読み込み中…</div>
{:else if app.phase === 'setup'}
  <div class="scroll"><Settings firstRun /></div>
{:else if app.phase === 'locked'}
  <Unlock />
{:else}
  <div class="shell">
    <Banners />
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="layout" data-pane={pane} data-wide-list={wideList} ontouchstart={onTouchStart} ontouchend={onTouchEnd}>
      <aside class="sidebar">
        <Sidebar onclose={() => (sidebarOpen = false)} />
      </aside>
      <section class="list">
        <NoteList onmenu={() => (sidebarOpen = true)} />
      </section>
      <main class="main">
        {#if router.route.name === 'note'}
          {#key router.route.id}
            <NoteView id={router.route.id} />
          {/key}
        {:else if router.route.name === 'settings'}
          <div class="scroll"><Settings /></div>
        {:else}
          <div class="center muted">ノートを選択してください</div>
        {/if}
      </main>
    </div>
  </div>
{/if}

<MenuHost />
<DialogHost />

{#if app.toast}
  <div class="toast" role="status">{app.toast}</div>
{/if}

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) 0 env(safe-area-inset-left, 0px);
  }
  .layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 240px 320px 1fr;
  }
  .sidebar,
  .list,
  .main {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .sidebar {
    background: var(--bg-soft);
    border-right: 1px solid var(--border);
  }
  .list {
    border-right: 1px solid var(--border);
  }
  .scroll {
    height: 100%;
    overflow-y: auto;
  }
  .center {
    height: 100%;
    display: grid;
    place-items: center;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
    background: var(--fg);
    color: var(--bg);
    padding: 0.5em 1em;
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    z-index: 100;
    max-width: calc(100vw - 32px);
  }
  @media (max-width: 1199px) {
    .layout {
      grid-template-columns: 220px 280px 1fr;
    }
  }
  @media (min-width: 900px) {
    .layout[data-wide-list='true'] {
      grid-template-columns: 240px 1fr;
    }
    .layout[data-wide-list='true'] .main {
      display: none;
    }
    .layout[data-wide-list='true'] .list {
      border-right: none;
    }
  }
  @media (max-width: 899px) {
    .layout {
      grid-template-columns: 1fr;
    }
    .sidebar,
    .list,
    .main {
      display: none;
    }
    .layout[data-pane='sidebar'] .sidebar,
    .layout[data-pane='list'] .list,
    .layout[data-pane='main'] .main {
      display: flex;
    }
    .sidebar,
    .list {
      border-right: none;
    }
  }
</style>
