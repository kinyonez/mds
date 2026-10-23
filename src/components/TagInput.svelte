<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { normalizeTag } from '../lib/domain/note';

  let { tags = $bindable(), onchange }: { tags: string[]; onchange: () => void } = $props();

  let draft = $state('');
  const listId = `tags-${Math.random().toString(36).slice(2)}`;
  // 補完候補は既存のタグ（件数順）
  const suggestions = $derived(app.tags.map(([t]) => t).filter((t) => !tags.includes(t)));

  function add(v: string) {
    const n = normalizeTag(v);
    draft = '';
    if (!n || tags.includes(n)) return;
    tags = [...tags, n];
    onchange();
  }

  function remove(t: string) {
    tags = tags.filter((x) => x !== t);
    onchange();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === 'Enter' || e.key === ',' || e.key === '、') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && tags.length) {
      remove(tags[tags.length - 1]);
    }
  }
</script>

<div class="tags">
  {#each tags as t (t)}
    <span class="chip">#{t}<button class="x" onclick={() => remove(t)} aria-label="{t} を外す">×</button></span>
  {/each}
  <input
    type="text"
    list={listId}
    placeholder={tags.length ? '' : 'タグを追加'}
    bind:value={draft}
    {onkeydown}
    onchange={() => draft && suggestions.includes(normalizeTag(draft)) && add(draft)}
    onblur={() => draft && add(draft)}
  />
  <datalist id={listId}>
    {#each suggestions as s (s)}<option value={s}></option>{/each}
  </datalist>
</div>

<style>
  .tags {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3em;
    align-items: center;
    min-width: 0;
  }
  .x {
    border: none;
    background: none;
    padding: 0 0 0 0.2em;
    min-height: 0;
    color: inherit;
    line-height: 1;
  }
  .tags input {
    flex: 1;
    min-width: 6em;
    border: none;
    background: none;
    padding: 0.1em 0;
    font-size: 0.85em;
    outline: none;
  }
</style>
