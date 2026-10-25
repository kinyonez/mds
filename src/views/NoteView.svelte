<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { app } from '../lib/app.svelte';
  import { deleteTemplate, moveNotes, newNoteFromTemplate, purgeNotes, restoreNotes, trashNotes } from '../lib/actions';
  import { dialogs } from '../lib/dialog.svelte';
  import type { NoteMeta } from '../lib/domain/frontmatter';
  import { isReserved, isTemplate, isTrashed, normalizeFolder, nowIso, parseNote, serializeNote } from '../lib/domain/note';
  import { TEMPLATE_FOLDER_KEY, TEMPLATE_TITLE_KEY } from '../lib/domain/template';
  import { prepareImage } from '../lib/image';
  import { menu } from '../lib/menu.svelte';
  import { loadUi, saveUi } from '../lib/platform/theme';
  import { href, router } from '../lib/router.svelte';
  import type { NoteRecord } from '../lib/store/db';
  import type { NoteStatus } from '../lib/sync/sync';
  import ConflictView from '../components/ConflictView.svelte';
  import Editor from '../components/Editor.svelte';
  import History from '../components/History.svelte';
  import Preview from '../components/Preview.svelte';
  import TagInput from '../components/TagInput.svelte';

  let { id: idProp }: { id: string } = $props();
  // 親は {#key} でノートごとに作り直すので id は固定。ルート変更で prop が先に undefined になるのを避ける
  const id = untrack(() => idProp);

  const LOCAL_SAVE_MS = 300;
  const QUEUE_MS = 3000;

  let rec = $state<NoteRecord | undefined>();
  let loading = $state(true);
  let meta = $state<NoteMeta | null>(null);
  let title = $state('');
  let tags = $state<string[]>([]);
  /** テンプレートの「作成時のフォルダ」（'' は作成時に表示中のフォルダ、'/' は未分類）と「作成時のタイトル」 */
  let tplFolder = $state('');
  let tplTitle = $state('');
  let body = $state('');
  /** front matter が壊れている時は生テキストをそのまま編集する */
  let raw = $state(false);
  let status = $state<NoteStatus>('synced');
  let tab = $state<'note' | 'history'>('note');
  let wide = $state(matchMedia('(min-width: 900px)').matches);
  let mode = $state<'edit' | 'preview' | 'split'>(loadUi('editor.mode', 'split'));
  const effectiveMode = $derived(mode === 'split' && !wide ? 'edit' : mode);

  let editor: ReturnType<typeof Editor> | undefined = $state();
  /** 自分が最後に IndexedDB へ書いた内容。これと違えば外部（マージ・再取得）での変更 */
  let saved = '';
  /**
   * ローカルの編集・保存の世代。読み直しの await 中に世代が進んでいたら、読んだ記録は
   * 自分の保存より古い可能性があるので差し替えない（入力中の内容を古い版で上書きしないため）
   */
  let gen = 0;
  let localTimer: ReturnType<typeof setTimeout> | null = null;
  let queueTimer: ReturnType<typeof setTimeout> | null = null;

  const trashed = $derived(!!meta && isTrashed(meta));
  const template = $derived(!!meta && isTemplate(meta));
  const tplFolderLabel = $derived(tplFolder === '' ? '作成時に表示中のフォルダ' : tplFolder === '/' ? '未分類' : tplFolder);
  const backlinks = $derived(app.notes.filter((n) => n.links.includes(id) && n.id !== id));
  const statusLabel = $derived<Record<NoteStatus, string>>({
    local: app.manual ? '未コミット' : 'ローカル保存済み',
    syncing: '同期中',
    synced: '同期済み',
    conflict: '競合あり',
    offline: 'オフライン',
  });

  function applyRecord(r: NoteRecord) {
    rec = r;
    saved = r.content;
    if (r.parseError) {
      raw = true;
      meta = null;
      body = r.content;
      return;
    }
    raw = false;
    const p = parseNote(r.content, id);
    meta = p.meta;
    title = p.meta.title ?? '';
    tags = p.meta.tags ?? [];
    tplFolder = String(p.meta[TEMPLATE_FOLDER_KEY] ?? '');
    tplTitle = String(p.meta[TEMPLATE_TITLE_KEY] ?? '');
    body = p.body;
  }

  function compose(): string {
    if (raw || !meta) return body;
    // 値が undefined のキーは書き出されない（空にしたテンプレート設定は消える）
    const extra = isTemplate(meta) ? { [TEMPLATE_FOLDER_KEY]: tplFolder || undefined, [TEMPLATE_TITLE_KEY]: tplTitle || undefined } : {};
    return serializeNote({ ...meta, title, tags, ...extra, updated: nowIso() }, body);
  }

  onMount(() => {
    app.lastNote = id;
    const mq = matchMedia('(min-width: 900px)');
    const f = () => (wide = mq.matches);
    mq.addEventListener('change', f);
    const vis = () => {
      if (document.visibilityState === 'hidden') void flushAll();
    };
    document.addEventListener('visibilitychange', vis);
    void (async () => {
      const r = await app.engine.openNote(id);
      if (r) {
        applyRecord(r);
        app.indexBody(id, r.content);
      }
      loading = false;
      status = await app.engine.noteStatus(id);
    })();
    return () => {
      mq.removeEventListener('change', f);
      document.removeEventListener('visibilitychange', vis);
    };
  });

  // ノートを閉じた時点でキューに積む
  onDestroy(() => void flushAll());

  // 同期でローカルの内容が変わったら（自動マージ・競合解決・再取得）表示を差し替える
  $effect(() => {
    void app.sync?.version;
    if (loading) return;
    const g = gen;
    void (async () => {
      const r = await app.engine.store.getNote(id);
      status = await app.engine.noteStatus(id);
      if (!r || localTimer || g !== gen) return;
      if (r.content !== saved) {
        applyRecord(r);
        editor?.setValue(body);
      } else rec = r;
    })();
  });

  function edited() {
    gen++;
    if (localTimer) clearTimeout(localTimer);
    localTimer = setTimeout(() => void saveLocal(), LOCAL_SAVE_MS);
    if (queueTimer) clearTimeout(queueTimer);
    queueTimer = setTimeout(() => void enqueue(), QUEUE_MS);
    status = 'local';
  }

  async function saveLocal() {
    if (localTimer) clearTimeout(localTimer);
    localTimer = null;
    const content = compose();
    saved = content;
    gen++;
    if (!raw && meta) meta = parseNote(content, id).meta;
    await app.engine.saveNote(id, content, { enqueue: false });
    gen++;
    app.indexBody(id, content);
    status = await app.engine.noteStatus(id);
  }

  async function enqueue() {
    if (queueTimer) clearTimeout(queueTimer);
    queueTimer = null;
    if (localTimer) await saveLocal();
    if (rec || saved) await app.engine.saveNote(id, saved, { enqueue: true });
    status = await app.engine.noteStatus(id);
  }

  async function flushAll() {
    if (localTimer || queueTimer) await enqueue();
  }

  async function onfiles(files: File[]): Promise<string[]> {
    const out: string[] = [];
    for (const f of files) {
      try {
        const { blob, name } = await prepareImage(f);
        const path = await app.engine.addAttachment(id, name, blob);
        out.push(`![${name}](${path})`);
      } catch (e) {
        app.notify((e as Error).message);
      }
    }
    return out;
  }

  function removeLink(target: string) {
    body = body.replace(new RegExp(`\\[\\[${target}(?:\\|[^\\]]*)?\\]\\]`, 'g'), '');
    editor?.setValue(body);
    edited();
  }

  function restoreVersion(content: string) {
    try {
      const p = parseNote(content, id);
      title = p.meta.title ?? '';
      tags = p.meta.tags ?? [];
      body = p.body;
    } catch {
      body = content;
    }
    tab = 'note';
    queueMicrotask(() => editor?.setValue(body));
    edited();
    app.notify('過去版を読み込みました。保存は通常どおり行われます');
  }

  function setMode(m: typeof mode) {
    mode = m;
    saveUi('editor.mode', m);
  }

  /** フォルダ移動などはエンジンが IndexedDB の内容を書き換えるので、先に手元の編集を保存する */
  async function withFlush(fn: () => Promise<unknown>) {
    await flushAll();
    await fn();
  }

  async function pickTemplateFolder() {
    const v = await dialogs.pickFolder('作成時のフォルダ', tplFolder === '/' ? '' : tplFolder);
    if (v == null) return;
    try {
      tplFolder = normalizeFolder(v) || '/';
      edited();
    } catch (e) {
      app.notify((e as Error).message);
    }
  }

  function showMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (template) {
      menu.open(r.left, r.bottom + 4, [
        { label: 'このテンプレートでノートを作成', run: () => withFlush(() => newNoteFromTemplate(id, router.list)) },
        { label: '画像を挿入', run: () => editor?.pickFiles() },
        { label: '履歴', run: () => (tab = 'history') },
        { label: '削除', danger: true, run: () => withFlush(() => deleteTemplate(id, title || 'テンプレート')) },
      ]);
      return;
    }
    menu.open(
      r.left,
      r.bottom + 4,
      trashed
        ? [
            { label: '復元', run: () => withFlush(() => restoreNotes([id])) },
            { label: '完全に削除', danger: true, run: () => withFlush(() => purgeNotes([id])) },
          ]
        : [
            { label: '移動', run: () => withFlush(() => moveNotes([id], meta?.folder ?? '')) },
            { label: '画像を挿入', run: () => editor?.pickFiles() },
            { label: '履歴', run: () => (tab = 'history') },
            { label: 'ゴミ箱へ', danger: true, run: () => withFlush(() => trashNotes([id])) },
          ],
    );
  }
</script>

<div class="note">
  <header>
    <div class="row1">
      <a class="back" href={href(router.list)} aria-label="一覧へ戻る">‹</a>
      {#if raw}
        <span class="title-raw">{id}</span>
      {:else}
        <input
          class="title"
          type="text"
          placeholder={template ? 'テンプレート名' : 'タイトル（空なら本文 1 行目）'}
          bind:value={title}
          oninput={edited}
          disabled={loading}
        />
      {/if}
      <span class="status {status}" title={app.sync?.lastError ?? ''}>{statusLabel[status]}</span>
      {#if wide}
        <button
          class="ghost focus"
          class:on={app.focus}
          onclick={() => (app.focus = !app.focus)}
          title={app.focus ? '全画面編集を終了' : '編集画面だけを全体に表示'}
          aria-label={app.focus ? '全画面編集を終了' : '全画面で編集'}
          aria-pressed={app.focus}>{app.focus ? '⤡' : '⤢'}</button
        >
      {/if}
      <button class="ghost more" onclick={showMenu} aria-label="メニュー">⋯</button>
    </div>
    {#if !raw && meta && template}
      <div class="tpl">
        <label>
          <span>作成時のタイトル</span>
          <input type="text" placeholder={'例: {{date}} 日報（空なら無題）'} bind:value={tplTitle} oninput={edited} />
        </label>
        <div class="tpl-row">
          <span>作成時のフォルダ</span>
          <button class="folder ghost small" onclick={pickTemplateFolder} title="作成時のフォルダを選ぶ">📁 {tplFolderLabel}</button>
          {#if tplFolder}
            <button class="ghost small" onclick={() => ((tplFolder = ''), edited())} title="指定を外す">×</button>
          {/if}
        </div>
        <div class="tpl-row">
          <span>作成時のタグ</span>
          <TagInput bind:tags onchange={edited} />
        </div>
      </div>
    {:else if !raw && meta}
      <div class="row2">
        <button class="folder ghost small" onclick={() => withFlush(() => moveNotes([id], meta?.folder ?? ''))} title="移動">
          📁 {trashed ? 'ゴミ箱' : meta.folder || '未分類'}
        </button>
        <TagInput bind:tags onchange={edited} />
      </div>
    {/if}
    <div class="row3">
      <div class="seg" role="tablist">
        <button role="tab" class:on={tab === 'note' && effectiveMode === 'edit'} onclick={() => ((tab = 'note'), setMode('edit'))}>編集</button>
        <button role="tab" class:on={tab === 'note' && effectiveMode === 'preview'} onclick={() => ((tab = 'note'), setMode('preview'))}>プレビュー</button>
        {#if wide}
          <button role="tab" class:on={tab === 'note' && effectiveMode === 'split'} onclick={() => ((tab = 'note'), setMode('split'))}>分割</button>
        {/if}
        <button role="tab" class:on={tab === 'history'} onclick={() => (tab = 'history')} disabled={!app.sync?.online}>履歴</button>
      </div>
      <button class="ghost small" onclick={() => editor?.pickFiles()} disabled={tab !== 'note' || effectiveMode === 'preview'}>画像</button>
    </div>
  </header>

  {#if rec?.parseError}
    <div class="banner error">front matter を解析できません: {rec.parseError}（生テキストを編集しています）</div>
  {/if}
  {#if template}
    <div class="banner info">
      テンプレートを編集中（本文とタイトルで <code>{'{{date}}'}</code> <code>{'{{time}}'}</code> <code>{'{{title}}'}</code> が使えます）
      <button onclick={() => withFlush(() => newNoteFromTemplate(id, router.list))}>このテンプレートでノートを作成</button>
    </div>
  {/if}
  {#if trashed}
    <div class="banner">
      このノートはゴミ箱にあります
      <button onclick={() => withFlush(() => restoreNotes([id]))}>復元</button>
    </div>
  {/if}

  <div class="body">
    {#if loading}
      <p class="muted pad">読み込み中…</p>
    {:else if !rec}
      <p class="muted pad">ノートが見つかりません。オフラインで本文が未取得の可能性があります。</p>
    {:else if rec.conflict}
      <ConflictView {id} local={rec.content} remote={rec.conflict.content} />
    {:else if tab === 'history'}
      <History {id} current={rec.content} onrestore={restoreVersion} />
    {:else}
      <div class="panes" data-mode={effectiveMode}>
        <div class="edit">
          <Editor
            bind:this={editor}
            value={body}
            notes={() => app.notes.filter((n) => !isReserved(n))}
            onchange={(v) => {
              body = v;
              edited();
            }}
            {onfiles}
          />
        </div>
        <div class="preview">
          <Preview {body} onremovelink={removeLink} />
          {#if backlinks.length}
            <section class="backlinks">
              <h3>バックリンク</h3>
              <ul>
                {#each backlinks as b (b.id)}
                  <li><a href={href({ name: 'note', id: b.id })}>{b.title}</a> <span class="muted small">{b.folder}</span></li>
                {/each}
              </ul>
            </section>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .note {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  header {
    border-bottom: 1px solid var(--border);
    padding: 0.4em 0.8em;
    display: flex;
    flex-direction: column;
    gap: 0.3em;
  }
  .tpl {
    display: flex;
    flex-direction: column;
    gap: 0.3em;
    font-size: 0.9em;
  }
  .tpl label,
  .tpl-row {
    display: flex;
    align-items: center;
    gap: 0.5em;
  }
  .tpl label > span,
  .tpl-row > span {
    flex-shrink: 0;
    width: 8em;
    color: var(--fg-muted);
    font-size: 0.9em;
  }
  .tpl input[type='text'] {
    min-height: 28px;
    padding: 0.2em 0.5em;
  }
  .tpl .folder {
    max-width: none;
  }
  .banner.info {
    background: var(--bg-active);
    color: var(--fg);
  }
  .banner code {
    font-family: var(--mono);
  }
  .row1,
  .row2,
  .row3 {
    display: flex;
    align-items: center;
    gap: 0.5em;
    min-width: 0;
  }
  .row3 {
    justify-content: space-between;
  }
  .back {
    display: none;
    font-size: 1.6em;
    line-height: 1;
    text-decoration: none;
    padding: 0 0.2em;
  }
  @media (max-width: 899px) {
    .back {
      display: inline;
    }
  }
  .title {
    flex: 1;
    min-width: 0;
    font-size: 1.15em;
    font-weight: 700;
    border: none;
    padding-left: 0;
    background: none;
  }
  .title-raw {
    flex: 1;
    font-family: var(--mono);
    color: var(--fg-muted);
  }
  .status {
    font-size: 0.75em;
    white-space: nowrap;
    padding: 0.1em 0.6em;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--fg-muted);
  }
  .status.synced {
    color: var(--ok);
  }
  .status.syncing {
    color: var(--accent);
  }
  .status.conflict {
    color: var(--conflict);
    border-color: var(--conflict);
  }
  .status.offline {
    color: var(--warn-fg);
    background: var(--warn-bg);
  }
  .focus {
    min-height: 0;
    padding: 0 0.4em;
    color: var(--fg-muted);
  }
  .focus.on {
    color: var(--accent);
  }
  .more {
    font-size: 1.2em;
    min-height: 0;
    padding: 0 0.4em;
  }
  .folder {
    min-height: 0;
    padding: 0.1em 0.4em;
    color: var(--fg-muted);
    white-space: nowrap;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .seg button {
    border: none;
    border-radius: 0;
    min-height: 28px;
    padding: 0.1em 0.8em;
    font-size: 0.85em;
    background: none;
  }
  .seg button.on {
    background: var(--bg-active);
    color: var(--accent);
  }
  .body {
    flex: 1;
    min-height: 0;
  }
  .pad {
    padding: 1em;
  }
  .panes {
    height: 100%;
    display: grid;
  }
  .panes[data-mode='split'] {
    grid-template-columns: 1fr 1fr;
  }
  .panes[data-mode='edit'] .preview,
  .panes[data-mode='preview'] .edit {
    display: none;
  }
  .edit,
  .preview {
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .preview {
    overflow-y: auto;
    padding: 0.5em 1.2em calc(2em + env(safe-area-inset-bottom, 0px));
  }
  .panes[data-mode='split'] .preview {
    border-left: 1px solid var(--border);
  }
  .backlinks {
    margin-top: 2em;
    border-top: 1px solid var(--border);
    padding-top: 0.5em;
  }
  .backlinks h3 {
    font-size: 0.85em;
    color: var(--fg-muted);
    margin: 0 0 0.3em;
  }
  .backlinks ul {
    margin: 0;
    padding-left: 1.2em;
  }
</style>
