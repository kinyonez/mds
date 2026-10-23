<script lang="ts">
  import { menu } from '../lib/menu.svelte';

  const m = $derived(menu.current);
  let el: HTMLElement | undefined = $state();
  let pos = $state({ left: 0, top: 0 });

  $effect(() => {
    if (!m || !el) return;
    // 画面外にはみ出さないよう位置を調整
    const r = el.getBoundingClientRect();
    pos = {
      left: Math.max(8, Math.min(m.x, innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(m.y, innerHeight - r.height - 8)),
    };
  });
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && menu.close()} />

{#if m}
  <div class="backdrop" role="presentation" onpointerdown={() => menu.close()}></div>
  <ul class="menu" role="menu" bind:this={el} style:left="{pos.left}px" style:top="{pos.top}px">
    {#each m.items as item (item.label)}
      <li role="none">
        <button
          role="menuitem"
          class:danger={item.danger}
          onclick={() => {
            menu.close();
            item.run();
          }}>{item.label}</button
        >
      </li>
    {/each}
  </ul>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .menu {
    position: fixed;
    z-index: 41;
    list-style: none;
    margin: 0;
    padding: 0.3em 0;
    min-width: 180px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
  }
  button {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    border-radius: 0;
    background: none;
    padding: 0.5em 1em;
  }
  button:hover {
    background: var(--bg-hover);
  }
  button.danger {
    color: var(--danger);
  }
</style>
