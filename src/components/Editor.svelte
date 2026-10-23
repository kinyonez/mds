<script lang="ts">
  import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
  import { languages } from '@codemirror/language-data';
  import { HighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
  import { EditorState } from '@codemirror/state';
  import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
  import { tags as t } from '@lezer/highlight';
  import { onDestroy, onMount } from 'svelte';
  import type { NoteSummary } from '../lib/domain/types';

  let {
    value,
    notes,
    onchange,
    onfiles,
  }: {
    value: string;
    notes: () => NoteSummary[];
    onchange: (v: string) => void;
    /** 貼り付け・ドロップされたファイルを保存し、挿入する Markdown を返す */
    onfiles: (files: File[]) => Promise<string[]>;
  } = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;

  // [[ で ID リンクの補完（タイトルで検索し ID を挿入）
  function linkCompletion(ctx: CompletionContext): CompletionResult | null {
    const m = ctx.matchBefore(/\[\[[^\]|\n]*/);
    if (!m) return null;
    const q = m.text.slice(2).toLowerCase();
    const options = notes()
      .filter((n) => !q || n.title.toLowerCase().includes(q) || n.id.toLowerCase().startsWith(q))
      .slice(0, 50)
      .map((n) => ({ label: n.title, detail: n.folder, apply: `${n.id}]]` }));
    return { from: m.from + 2, options, filter: false };
  }

  const highlight = HighlightStyle.define([
    { tag: t.heading1, fontSize: '1.35em', fontWeight: '700' },
    { tag: t.heading2, fontSize: '1.2em', fontWeight: '700' },
    { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.link, t.url], color: 'var(--accent)' },
    { tag: t.monospace, fontFamily: 'var(--mono)', color: 'var(--conflict)' },
    { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--fg-faint)' },
    { tag: t.quote, color: 'var(--fg-muted)' },
    { tag: [t.keyword, t.operator], color: 'var(--accent)' },
    { tag: [t.string, t.regexp], color: 'var(--ok)' },
    { tag: t.comment, color: 'var(--fg-faint)', fontStyle: 'italic' },
  ]);

  const theme = EditorView.theme({
    '&': { height: '100%', fontSize: '15px', backgroundColor: 'var(--bg)', color: 'var(--fg)' },
    '.cm-scroller': { fontFamily: 'var(--font)', lineHeight: '1.65', overflow: 'auto' },
    '.cm-content': { padding: '12px 0 40vh', caretColor: 'var(--fg)' },
    '.cm-line': { padding: '0 16px 0 4px' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', border: 'none', color: 'var(--fg-faint)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--bg-active) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--fg)' },
    '.cm-tooltip': { backgroundColor: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--fg)' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--bg-active)', color: 'var(--fg)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-soft)', border: '1px solid var(--border)', color: 'var(--fg-muted)' },
  });

  async function insertFiles(files: File[], pos?: number) {
    const snippets = await onfiles(files);
    if (!view || !snippets.length) return;
    const at = pos ?? view.state.selection.main.head;
    const text = snippets.join('\n');
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
    view.focus();
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          indentOnInput(),
          // Markdown シンタックスハイライト、見出しの折りたたみ、リストの自動継続（markdownKeymap）
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(highlight),
          foldGutter({ openText: '▾', closedText: '▸' }),
          autocompletion({ override: [linkCompletion], activateOnTyping: true }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ autocapitalize: 'sentences', spellcheck: 'false' }),
          placeholder('本文を入力…'),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onchange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste(e) {
              const files = [...(e.clipboardData?.files ?? [])];
              if (!files.length) return false;
              e.preventDefault();
              void insertFiles(files);
              return true;
            },
            drop(e, v) {
              const files = [...(e.dataTransfer?.files ?? [])];
              if (!files.length) return false;
              e.preventDefault();
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined;
              void insertFiles(files, pos);
              return true;
            },
          }),
        ],
      }),
    });
  });

  onDestroy(() => view?.destroy());

  /** 外部（マージ・再取得）で内容が変わった時に差し替える */
  export function setValue(v: string) {
    if (!view || view.state.doc.toString() === v) return;
    const head = Math.min(view.state.selection.main.head, v.length);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v }, selection: { anchor: head } });
  }

  export function pickFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => void insertFiles([...(input.files ?? [])]);
    input.click();
  }

  export function focus() {
    view?.focus();
  }
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    height: 100%;
    min-height: 0;
  }
</style>
