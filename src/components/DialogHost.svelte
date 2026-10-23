<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { dialogs } from '../lib/dialog.svelte';

  const d = $derived(dialogs.current);
  let value = $state('');
  let filter = $state('');
  /** 一覧から明示的に選んだか。選んでいなければ入力したパスをそのまま移動先にする */
  let picked = $state(false);
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (d) {
      value = d.value ?? '';
      filter = '';
      picked = false;
      queueMicrotask(() => input?.focus());
    }
  });

  const folders = $derived(
    ['', ...app.folderSet].filter((f, i, a) => a.indexOf(f) === i && (!filter || f.toLowerCase().includes(filter.toLowerCase()))),
  );

  const chosen = $derived(picked || !filter.trim() ? value : filter.trim());

  function pick(f: string) {
    value = f;
    picked = true;
  }

  function submit(e: Event) {
    e.preventDefault();
    if (!d) return;
    if (d.kind === 'confirm') dialogs.close(true);
    else if (d.kind === 'folder') dialogs.close(chosen);
    else dialogs.close(value);
  }
</script>

{#if d}
  <div class="backdrop" role="dialog" aria-modal="true" tabindex="-1" onkeydown={(e) => e.key === 'Escape' && dialogs.close(null)} onclick={(e) => e.target === e.currentTarget && dialogs.close(null)}>
    <form class="dialog" aria-label={d.title} onsubmit={submit}>
      <h2>{d.title}</h2>
      {#if d.message}<p class="muted">{d.message}</p>{/if}
      {#if d.kind === 'prompt'}
        <input type="text" bind:this={input} bind:value placeholder={d.placeholder} />
      {:else if d.kind === 'folder'}
        <input type="search" bind:this={input} bind:value={filter} oninput={() => (picked = false)} placeholder="フォルダを絞り込み、または新しいパスを入力" />
        <ul class="folders">
          {#each folders as f (f)}
            <li>
              <button type="button" class:selected={chosen === f} onclick={() => pick(f)} ondblclick={submit}>
                {f || '未分類（ルート）'}
              </button>
            </li>
          {/each}
          {#if filter && !folders.includes(filter.trim())}
            <li>
              <button type="button" class:selected={chosen === filter.trim()} onclick={() => pick(filter.trim())}>
                新しいフォルダ: {filter.trim()}
              </button>
            </li>
          {/if}
        </ul>
      {/if}
      <div class="actions">
        <button type="button" onclick={() => dialogs.close(null)}>キャンセル</button>
        <button type="submit" class={d.danger ? 'primary danger-bg' : 'primary'}>{d.confirmLabel ?? 'OK'}</button>
      </div>
    </form>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: grid;
    place-items: center;
    z-index: 50;
    padding: 16px;
  }
  .dialog {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow);
    padding: 1em 1.2em;
    width: min(440px, 100%);
    max-height: calc(var(--app-height) - 32px);
    display: flex;
    flex-direction: column;
    gap: 0.6em;
  }
  h2 {
    margin: 0;
    font-size: 1.05em;
  }
  p {
    margin: 0;
    white-space: pre-wrap;
  }
  .folders {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    max-height: 40vh;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .folders button {
    width: 100%;
    text-align: left;
    border: none;
    border-radius: 0;
    background: none;
  }
  .folders button.selected {
    background: var(--bg-active);
    color: var(--accent);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5em;
  }
  :global(.danger-bg) {
    background: var(--danger) !important;
    border-color: var(--danger) !important;
  }
</style>
