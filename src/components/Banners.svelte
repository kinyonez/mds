<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { router } from '../lib/router.svelte';

  const s = $derived(app.sync);
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const waitSec = $derived(s?.paused?.until ? Math.max(0, Math.ceil((s.paused.until - now) / 1000)) : 0);
  const tokenUrl = 'https://github.com/settings/personal-access-tokens';
</script>

{#if app.updateAvailable}
  <div class="banner">
    更新があります
    <button class="primary" onclick={() => app.applyUpdate?.()}>リロード</button>
  </div>
{/if}

{#if app.expiryWarning !== null}
  <div class="banner">
    トークンの有効期限まで残り {app.expiryWarning} 日です。
    <a href={tokenUrl} target="_blank" rel="noopener noreferrer">GitHub の設定ページ</a>
    で再発行し、設定画面で貼り替えてください。
  </div>
{/if}

{#if app.readOnlyOffline}
  <div class="banner">
    ロック中（キャッシュのみ閲覧）。編集内容は解除後に同期されます。
    <button onclick={() => (app.phase = 'locked')}>ロック解除</button>
  </div>
{/if}

{#if s?.paused}
  <div class="banner error">
    {s.paused.message}
    {#if s.paused.reason === 'ratelimit' && waitSec > 0}（あと {waitSec} 秒で自動再開）{/if}
    {#if s.paused.reason === 'notfound'}
      <span class="small">プライベートリポに権限がない場合も「見つからない」になります。</span>
    {/if}
    {#if s.paused.reason !== 'ratelimit'}
      <button onclick={() => router.go({ name: 'settings' })}>設定を開く</button>
    {/if}
  </div>
{/if}

{#if s?.indexMissing && !s.paused}
  <div class="banner">
    データリポに index.json がありません。設定画面からひな形を作成してください。
    <button onclick={() => router.go({ name: 'settings' })}>設定を開く</button>
  </div>
{/if}

{#if app.unsynced > 0 && (!s?.online || s?.lastError)}
  <div class="banner">
    未同期 {app.unsynced} 件
    {#if !s?.online}（オフライン）{:else if s?.lastError}— {s.lastError}{/if}
    {#if s?.online && !s?.paused}
      <button onclick={() => app.engine.sync()}>今すぐ同期</button>
    {/if}
  </div>
{/if}
