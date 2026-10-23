<script lang="ts">
  import { app } from '../lib/app.svelte';

  let pass = $state('');
  let remember = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      await app.unlock(pass, remember);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  <form onsubmit={submit}>
    <h1>mds</h1>
    <p class="muted small">{app.config?.owner}/{app.config?.repo}</p>
    {#if app.unsynced > 0}
      <p class="warn">未同期の変更が {app.unsynced} 件あります</p>
    {/if}
    <!-- svelte-ignore a11y_autofocus -->
    <input type="password" placeholder="パスフレーズ" bind:value={pass} autocomplete="current-password" autofocus />
    <label><input type="checkbox" bind:checked={remember} /> このデバイスで記憶する</label>
    {#if error}<p class="error">{error}</p>{/if}
    <button class="primary" type="submit" disabled={busy || !pass}>{busy ? '解除中…' : 'ロック解除'}</button>
    <button type="button" class="ghost small" onclick={() => app.browseOffline()}>ロックしたままキャッシュを閲覧</button>
  </form>
</div>

<style>
  .wrap {
    height: 100%;
    display: grid;
    place-items: center;
    padding: 16px;
  }
  form {
    width: min(360px, 100%);
    display: flex;
    flex-direction: column;
    gap: 0.7em;
  }
  h1 {
    margin: 0;
  }
  p {
    margin: 0;
  }
  label {
    display: flex;
    gap: 0.4em;
    align-items: center;
    font-size: 0.9em;
  }
  .error {
    color: var(--danger);
  }
  .warn {
    color: var(--warn-fg);
    background: var(--warn-bg);
    padding: 0.4em 0.6em;
    border-radius: var(--radius);
  }
</style>
