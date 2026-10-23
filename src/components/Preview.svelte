<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { dialogs } from '../lib/dialog.svelte';
  import { createRenderer, parseAttachmentSrc } from '../lib/markdown';

  let { body, onremovelink }: { body: string; onremovelink?: (id: string) => void } = $props();

  // [[ID]] は title に解決して表示。削除済みは打ち消し線
  const render = $derived.by(() => {
    const byId = app.byId;
    return createRenderer({ title: (id) => byId.get(id)?.title ?? null });
  });
  const html = $derived(render(body));

  let el: HTMLElement | undefined = $state();
  const urls: string[] = [];

  // 添付画像は IndexedDB のキャッシュ（無ければ API で取得）から blob URL で表示する
  $effect(() => {
    void html;
    if (!el) return;
    for (const img of el.querySelectorAll('img')) {
      const a = parseAttachmentSrc(img.getAttribute('src') ?? '');
      if (!a) continue;
      img.removeAttribute('src');
      img.alt ||= a.filename;
      void app.engine.loadAttachment(a.noteId, a.filename).then(
        (blob) => {
          if (!blob) return;
          const u = URL.createObjectURL(blob);
          urls.push(u);
          img.src = u;
        },
        () => img.classList.add('missing'),
      );
    }
    return () => {
      for (const u of urls.splice(0)) URL.revokeObjectURL(u);
    };
  });

  async function onclick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('a.broken-link') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const id = a.dataset.noteLink!;
    if (onremovelink && (await dialogs.confirm('リンク先のノートは削除されています', { message: 'このリンクを除去しますか？', confirmLabel: 'リンクを除去' }))) {
      onremovelink(id);
    }
  }
</script>

<!-- markdown-it の出力は DOMPurify でサニタイズ済み -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="markdown" bind:this={el} {onclick}>{@html html}</div>

<style>
  .markdown :global(img.missing) {
    outline: 1px dashed var(--danger);
    min-width: 2em;
    min-height: 1em;
  }
</style>
