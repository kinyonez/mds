<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { dialogs } from '../lib/dialog.svelte';
  import { getTheme, setTheme, type Theme } from '../lib/platform/theme';
  import { GitHubClient, GitHubError, type TreeChange } from '../lib/sync/github';
  import buildIndexScript from '../../data-template/.github/scripts/build-index.mjs?raw';
  import workflowYaml from '../../data-template/.github/workflows/index.yml?raw';
  import foldersTemplate from '../../data-template/_meta/folders.json?raw';
  import indexTemplate from '../../data-template/index.json?raw';

  let { firstRun = false }: { firstRun?: boolean } = $props();

  const c = app.config;
  let repoInput = $state(c ? `${c.owner}/${c.repo}` : '');
  let branch = $state(c?.branch ?? 'main');
  let token = $state('');
  let pass1 = $state('');
  let pass2 = $state('');
  let remember = $state(true);
  let expiry = $state(c?.tokenExpiry ?? '');
  let theme = $state<Theme>(getTheme());
  let busy = $state(false);
  let testResult = $state<{ ok: boolean; message: string } | null>(null);
  let clearOnLogout = $state(false);

  const parsed = $derived.by(() => {
    const m = /^\s*([\w.-]+)\/([\w.-]+)\s*$/.exec(repoInput);
    return m ? { owner: m[1], repo: m[2] } : null;
  });
  const workflowUrl = $derived(
    parsed
      ? `https://github.com/${parsed.owner}/${parsed.repo}/new/${encodeURIComponent(branch || 'main')}?filename=${encodeURIComponent('.github/workflows/index.yml')}&value=${encodeURIComponent(workflowYaml)}`
      : '',
  );

  function clientFromInputs(): GitHubClient | null {
    if (!parsed) return null;
    if (token.trim()) return new GitHubClient(token.trim(), { ...parsed, branch: branch || 'main' });
    return app.engine.getClient();
  }

  function describe(e: unknown): string {
    if (e instanceof GitHubError) {
      switch (e.kind) {
        case 'auth':
          return 'トークンが無効です（401 Bad credentials）';
        case 'notfound':
          return 'リポジトリが見つかりません。プライベートリポに権限がない場合も 404 になります。リポ名とトークンの Repository access を確認してください';
        case 'forbidden':
          return '対象リポへの権限がありません。トークンを再発行してください';
        case 'ratelimit':
          return 'API のレート制限中です。しばらく待ってから再試行してください';
        case 'network':
          return 'ネットワークに接続できません';
      }
    }
    return (e as Error).message;
  }

  // 接続テスト: GET /repos/{o}/{r} を叩き、permissions.push が true か確認
  async function test() {
    const client = clientFromInputs();
    if (!client) {
      testResult = { ok: false, message: 'リポジトリは owner/notes-data の形式で入力してください' };
      return;
    }
    busy = true;
    testResult = null;
    try {
      const r = await client.getRepo();
      if (!r.push) testResult = { ok: false, message: '読み取りはできますが書き込み権限がありません（Contents: Read and write が必要）' };
      else
        testResult = {
          ok: true,
          message: `接続できました${r.private ? '' : '（注意: 公開リポジトリです）'}`,
        };
      const exp = await client.fetchTokenExpiration();
      if (exp && !expiry) expiry = new Date(exp.replace(' UTC', 'Z').replace(' ', 'T')).toISOString().slice(0, 10);
    } catch (e) {
      testResult = { ok: false, message: describe(e) };
    } finally {
      busy = false;
    }
  }

  async function save() {
    if (!parsed) return app.notify('リポジトリは owner/notes-data の形式で入力してください');
    if (!token.trim()) return app.notify('トークンを入力してください');
    if (pass1.length < 8) return app.notify('パスフレーズは 8 文字以上にしてください');
    if (pass1 !== pass2) return app.notify('パスフレーズ（確認）が一致しません');
    busy = true;
    try {
      await app.saveCredentials({ ...parsed, branch: branch || 'main', tokenExpiry: expiry || undefined }, token.trim(), pass1, remember);
      token = pass1 = pass2 = '';
      app.notify('保存しました');
    } catch (e) {
      app.notify(describe(e));
    } finally {
      busy = false;
    }
  }

  async function saveExpiry() {
    if (!app.config) return;
    await app.saveConfig({ ...app.config, tokenExpiry: expiry || undefined });
    app.notify('有効期限を保存しました');
  }

  // データリポのひな形が無ければ初回コミットで作る（ワークフローは Workflow 権限が要るので手動）
  async function createTemplate() {
    const client = clientFromInputs();
    if (!client) return;
    busy = true;
    try {
      const files: TreeChange[] = [
        { path: '_meta/folders.json', content: foldersTemplate },
        { path: 'index.json', content: indexTemplate },
        { path: '.github/scripts/build-index.mjs', content: buildIndexScript },
      ];
      const r = await client.commitBatch('chore: notes-data のひな形を作成', async (tree) => files.filter((f) => !tree.has(f.path)));
      app.notify(r.commit ? 'ひな形を作成しました' : 'ひな形は作成済みです');
      await app.engine.sync();
    } catch (e) {
      if (e instanceof GitHubError && e.status === 409) app.notify('リポジトリが空です。GitHub 上で README 付きで作成してから再実行してください');
      else app.notify(describe(e));
    } finally {
      busy = false;
    }
  }

  async function copyWorkflow() {
    try {
      await navigator.clipboard.writeText(workflowYaml);
      app.notify('コピーしました');
    } catch {
      app.notify('コピーできませんでした。下のテキストを選択してコピーしてください');
    }
  }

  async function logout() {
    const ok = await dialogs.confirm('ログアウトしますか？', {
      message: clearOnLogout ? 'トークンとローカルのデータ（未送信の編集を含む）をすべて削除します。' : 'トークンを削除します。ローカルのデータは残ります。',
      confirmLabel: 'ログアウト',
      danger: true,
    });
    if (ok) await app.logout(clearOnLogout);
  }
</script>

<div class="settings">
  <h1>{firstRun ? 'はじめに' : '設定'}</h1>
  {#if firstRun}
    <p class="muted">
      GitHub のプライベートリポジトリをメモの保存先にします。データ用のリポジトリ（例: <code>notes-data</code>）を作り、
      そのリポジトリだけに権限を付けたトークンを発行して入力してください。
    </p>
  {/if}

  <section>
    <h2>接続</h2>
    <label>リポジトリ<input type="text" placeholder="owner/notes-data" bind:value={repoInput} autocapitalize="off" autocomplete="off" /></label>
    <label>ブランチ<input type="text" bind:value={branch} autocapitalize="off" /></label>
    <label>
      トークン（Fine-grained personal access token）
      <input type="password" placeholder="github_pat_…" bind:value={token} autocomplete="off" />
    </label>
    <details>
      <summary class="small">トークンの発行方法</summary>
      <ul class="small">
        <li>
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Fine-grained personal access token</a>
          を新規作成
        </li>
        <li>Repository access: <b>Only select repositories</b> でデータ用リポだけを選ぶ</li>
        <li>Permissions: <b>Contents: Read and write</b>（Metadata: Read-only は自動で付く）</li>
        <li>有効期限: 最長 1 年。期限の 14 日前から警告します</li>
      </ul>
    </details>
    <label>パスフレーズ<input type="password" bind:value={pass1} autocomplete="new-password" /></label>
    <label>パスフレーズ（確認）<input type="password" bind:value={pass2} autocomplete="new-password" /></label>
    <label class="check"><input type="checkbox" bind:checked={remember} /> このデバイスで記憶する（次回からパスフレーズを省略）</label>
    {#if app.config}
      <p class="small muted">接続先やトークンを変更する場合は、トークンとパスフレーズを入力し直してください。</p>
    {/if}
    <p class="small muted">トークンはパスフレーズから導出した鍵（PBKDF2 600,000 回）で AES-GCM 暗号化して保存します。</p>
    <div class="actions">
      <button onclick={test} disabled={busy || !parsed}>接続テスト</button>
      <button class="primary" onclick={save} disabled={busy}>保存して接続</button>
    </div>
    {#if testResult}
      <p class={testResult.ok ? 'ok' : 'error'}>{testResult.message}</p>
    {/if}
  </section>

  {#if parsed && (app.config || token)}
    <section>
      <h2>データリポのひな形</h2>
      <p class="small muted">
        <code>_meta/folders.json</code>、空の <code>index.json</code>、<code>.github/scripts/build-index.mjs</code> を 1 コミットで作成します（既にあるファイルは触りません）。
      </p>
      <div class="actions"><button onclick={createTemplate} disabled={busy}>ひな形を作成</button></div>
      <p class="small">
        ワークフローファイルのコミットには Workflow 権限が必要なため、GitHub 上で作成してください。
        <a href={workflowUrl} target="_blank" rel="noopener noreferrer">GitHub で .github/workflows/index.yml を作成</a>
        （内容は入力済みで開きます。開かない場合は下の内容を貼り付け）
      </p>
      <div class="actions"><button class="small" onclick={copyWorkflow}>YAML をコピー</button></div>
      <pre class="yaml">{workflowYaml}</pre>
    </section>
  {/if}

  {#if app.config}
    <section>
      <h2>トークンの有効期限</h2>
      <p class="small muted">取得できればレスポンスヘッダから自動で設定します。取れない環境では手入力してください。</p>
      <div class="inline">
        <input type="date" bind:value={expiry} />
        <button onclick={saveExpiry}>保存</button>
      </div>
    </section>
  {/if}

  <section>
    <h2>同期</h2>
    <label class="check">
      <input type="radio" name="syncMode" value="auto" checked={!app.manual} onchange={() => app.setSyncMode('auto')} />
      自動 — 編集停止から 3 秒でノートごとにコミット
    </label>
    <label class="check">
      <input type="radio" name="syncMode" value="manual" checked={app.manual} onchange={() => app.setSyncMode('manual')} />
      手動 — 「同期」ボタンで未コミットの変更をまとめて 1 コミット
    </label>
    <p class="small muted">
      どちらのモードでも編集は端末内（IndexedDB）に即時保存され、他の端末の変更は 5 分おきとアプリ復帰時に取り込みます。
      手動モードではコミットするまで他の端末には反映されません。手動から自動に切り替えると、溜まっている変更を 1 コミットで送ります。
    </p>
  </section>

  <section>
    <h2>表示</h2>
    <div class="inline">
      <select bind:value={theme} onchange={() => setTheme(theme)} aria-label="テーマ">
        <option value="system">システムに合わせる</option>
        <option value="light">ライト</option>
        <option value="dark">ダーク</option>
      </select>
    </div>
  </section>

  {#if app.config}
    <section>
      <h2>ログアウト</h2>
      <label class="check"><input type="checkbox" bind:checked={clearOnLogout} /> ローカルのデータ（キャッシュ・未送信の編集）も削除する</label>
      {#if clearOnLogout && app.unsynced > 0}
        <p class="error small">未同期の変更が {app.unsynced} 件あります。削除すると失われます。</p>
      {/if}
      <div class="actions"><button class="danger" onclick={logout}>ログアウト</button></div>
    </section>
  {/if}

  {#if !firstRun}
    <p class="small muted"><a href="#/">← ノート一覧へ</a></p>
  {/if}
</div>

<style>
  .settings {
    max-width: 640px;
    margin: 0 auto;
    padding: 1em 1em calc(3em + env(safe-area-inset-bottom, 0px));
  }
  h1 {
    font-size: 1.3em;
  }
  h2 {
    font-size: 1em;
    margin: 0 0 0.5em;
  }
  section {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1em;
    margin-bottom: 1em;
    display: flex;
    flex-direction: column;
    gap: 0.6em;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.2em;
    font-size: 0.9em;
  }
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.4em;
  }
  .actions,
  .inline {
    display: flex;
    gap: 0.5em;
    flex-wrap: wrap;
    align-items: center;
  }
  .inline input,
  .inline select {
    width: auto;
  }
  .ok {
    color: var(--ok);
    margin: 0;
  }
  .error {
    color: var(--danger);
    margin: 0;
  }
  p {
    margin: 0;
  }
  ul {
    margin: 0.3em 0;
    padding-left: 1.2em;
  }
  code {
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .yaml {
    margin: 0;
    font: 0.75em/1.4 var(--mono);
    background: var(--bg-soft);
    padding: 0.6em;
    border-radius: var(--radius);
    overflow-x: auto;
    max-height: 240px;
  }
</style>
