<script lang="ts">
  import { app } from '../lib/app.svelte';

  const s = $derived(app.sync);
  const label = $derived(
    !s?.configured
      ? 'ローカルのみ'
      : !s.online
        ? 'オフライン'
        : s.paused
          ? '停止中'
          : s.syncing
            ? '同期中'
            : s.changes
              ? `${s.mode === 'manual' ? '未コミット' : '未送信'} ${s.changes}`
              : '同期済み',
  );
  const tone = $derived(!s?.online || s?.paused ? 'warn' : s?.changes ? 'busy' : 'ok');
</script>

<button
  class="badge {tone}"
  title={s?.lastError ?? (s?.mode === 'manual' ? '変更をまとめてコミット' : '今すぐ同期')}
  onclick={() => app.syncNow()}
  disabled={!s?.configured || s?.syncing}
>
  <span class="dot"></span>{label}
</button>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35em;
    font-size: 0.75em;
    min-height: 0;
    padding: 0.1em 0.6em;
    border-radius: 999px;
    color: var(--fg-muted);
  }
  .dot {
    width: 0.55em;
    height: 0.55em;
    border-radius: 50%;
    background: var(--ok);
  }
  .busy .dot {
    background: var(--accent);
  }
  .warn .dot {
    background: var(--conflict);
  }
</style>
