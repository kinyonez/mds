<script lang="ts">
  import { diffLines } from 'diff';
  import { app } from '../lib/app.svelte';
  import { router } from '../lib/router.svelte';

  let { id, local, remote }: { id: string; local: string; remote: string } = $props();

  const parts = $derived(diffLines(remote, local));
  let busy = $state(false);

  async function choose(c: 'local' | 'remote' | 'copy') {
    busy = true;
    try {
      const copy = await app.engine.resolveConflict(id, c);
      app.notify(c === 'local' ? 'ローカル版を採用しました' : c === 'remote' ? 'リモート版を採用しました' : 'ローカル版を別ノートとして保存しました');
      if (copy) router.go({ name: 'note', id: copy });
    } finally {
      busy = false;
    }
  }
</script>

<section class="conflict">
  <div class="head">
    <strong>競合があります</strong>
    <span class="muted small">他のデバイスで同じ箇所が変更されました。どちらかを採用し、細かい修正は採用後に行ってください。</span>
  </div>
  <div class="actions">
    <button class="primary" disabled={busy} onclick={() => choose('local')}>ローカルを採用</button>
    <button disabled={busy} onclick={() => choose('remote')}>リモートを採用</button>
    <button disabled={busy} onclick={() => choose('copy')}>ローカルを別ノートとして保存</button>
  </div>
  <div class="cols">
    <div>
      <h3>リモート版</h3>
      <pre>{#each parts as p, i (i)}{#if !p.added}<span class:del={p.removed}>{p.value}</span>{/if}{/each}</pre>
    </div>
    <div>
      <h3>ローカル版</h3>
      <pre>{#each parts as p, i (i)}{#if !p.removed}<span class:add={p.added}>{p.value}</span>{/if}{/each}</pre>
    </div>
  </div>
</section>

<style>
  .conflict {
    padding: 0.8em 1em;
    display: flex;
    flex-direction: column;
    gap: 0.6em;
    overflow-y: auto;
    height: 100%;
  }
  .head {
    display: flex;
    flex-direction: column;
    color: var(--conflict);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5em;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.8em;
  }
  @media (max-width: 899px) {
    .cols {
      grid-template-columns: 1fr;
    }
  }
  h3 {
    margin: 0 0 0.3em;
    font-size: 0.9em;
    color: var(--fg-muted);
  }
  pre {
    margin: 0;
    padding: 0.6em;
    background: var(--bg-soft);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    white-space: pre-wrap;
    word-break: break-word;
    font: 0.85em/1.5 var(--mono);
    overflow-x: auto;
  }
  .add {
    background: var(--diff-add);
  }
  .del {
    background: var(--diff-del);
  }
</style>
