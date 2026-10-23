<script lang="ts">
  import { diffLines, type Change } from 'diff';
  import { app } from '../lib/app.svelte';
  import type { CommitInfo } from '../lib/sync/github';

  let { id, current, onrestore }: { id: string; current: string; onrestore: (content: string) => void } = $props();

  let commits = $state<CommitInfo[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);
  /** 比較する 2 版（'current' は今の編集内容） */
  let from = $state<string | null>(null);
  let to = $state<string>('current');
  let texts = $state<Record<string, string>>({});
  let wide = $state(matchMedia('(min-width: 900px)').matches);

  $effect(() => {
    const mq = matchMedia('(min-width: 900px)');
    const f = () => (wide = mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  });

  $effect(() => {
    void load();
  });

  async function load() {
    loading = true;
    error = null;
    try {
      commits = await app.engine.history(id);
      if (commits[0]) from = commits[0].sha;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function text(sha: string): Promise<string> {
    if (sha === 'current') return current;
    if (!(sha in texts)) texts[sha] = await app.engine.versionAt(id, sha);
    return texts[sha];
  }

  let parts = $state<Change[]>([]);
  $effect(() => {
    const a = from;
    const b = to;
    void current;
    if (!a) return;
    void Promise.all([text(a), text(b)]).then(([x, y]) => (parts = diffLines(x, y)), (e) => (error = (e as Error).message));
  });

  const rows = $derived.by(() => {
    // side-by-side 用に削除と追加を左右に並べる
    const out: { l?: string; r?: string; kind: 'same' | 'change' }[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p.added && !p.removed) out.push({ l: p.value, r: p.value, kind: 'same' });
      else if (p.removed && parts[i + 1]?.added) {
        out.push({ l: p.value, r: parts[i + 1].value, kind: 'change' });
        i++;
      } else out.push({ l: p.removed ? p.value : undefined, r: p.added ? p.value : undefined, kind: 'change' });
    }
    return out;
  });

  const label = (sha: string) => {
    if (sha === 'current') return '現在の内容';
    const c = commits.find((x) => x.sha === sha);
    return c ? `${new Date(c.date).toLocaleString('ja-JP')} ${c.message}` : sha.slice(0, 7);
  };

  async function restore() {
    if (from) onrestore(await text(from));
  }
</script>

{#if !app.sync?.online || !app.sync?.configured}
  <p class="muted pad">履歴はオンライン時のみ表示できます。</p>
{:else if loading}
  <p class="muted pad">読み込み中…</p>
{:else if error}
  <p class="pad error">{error}</p>
{:else if !commits.length}
  <p class="muted pad">まだ履歴はありません。</p>
{:else}
  <div class="history">
    <div class="pick">
      <label>
        <span class="small muted">比較元</span>
        <select bind:value={from}>
          {#each commits as c (c.sha)}<option value={c.sha}>{label(c.sha)}</option>{/each}
        </select>
      </label>
      <label>
        <span class="small muted">比較先</span>
        <select bind:value={to}>
          <option value="current">現在の内容</option>
          {#each commits as c (c.sha)}<option value={c.sha}>{label(c.sha)}</option>{/each}
        </select>
      </label>
      <button onclick={restore} disabled={!from} title="過去版の内容を現在の編集内容として読み込みます（保存は通常どおり）">比較元の版に戻す</button>
    </div>

    {#if wide}
      <div class="sbs">
        {#each rows as r, i (i)}
          <pre class:del={r.kind === 'change' && r.l !== undefined}>{r.l ?? ''}</pre>
          <pre class:add={r.kind === 'change' && r.r !== undefined}>{r.r ?? ''}</pre>
        {/each}
      </div>
    {:else}
      <pre class="unified">{#each parts as p, i (i)}<span class:add={p.added} class:del={p.removed}>{#each p.value.replace(/\n$/, '').split('\n') as line, j (j)}{p.added ? '+ ' : p.removed ? '- ' : '  '}{line}{'\n'}{/each}</span>{/each}</pre>
    {/if}

    <h3>コミット</h3>
    <ul class="commits">
      {#each commits as c (c.sha)}
        <li>
          <button class="ghost" class:selected={from === c.sha} onclick={() => (from = c.sha)}>
            <span class="date">{new Date(c.date).toLocaleString('ja-JP')}</span>
            <span>{c.message}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .pad {
    padding: 1em;
  }
  .error {
    color: var(--danger);
  }
  .history {
    padding: 0.8em 1em;
    overflow-y: auto;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.6em;
  }
  .pick {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5em;
    align-items: flex-end;
  }
  .pick label {
    flex: 1 1 200px;
    display: flex;
    flex-direction: column;
  }
  pre {
    margin: 0;
    font: 0.82em/1.5 var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .sbs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .sbs pre {
    padding: 0 0.5em;
    border-right: 1px solid var(--border);
  }
  .unified {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5em;
    overflow-x: auto;
  }
  .add {
    background: var(--diff-add);
  }
  .del {
    background: var(--diff-del);
  }
  h3 {
    margin: 0.5em 0 0;
    font-size: 0.9em;
    color: var(--fg-muted);
  }
  .commits {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .commits button {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    border-radius: 0;
    border-bottom: 1px solid var(--border);
  }
  .commits button.selected {
    background: var(--bg-active);
  }
  .date {
    font-size: 0.8em;
    color: var(--fg-faint);
  }
</style>
