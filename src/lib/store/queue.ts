import type { DB, QueueItem, QueueOp } from './db';

const MIN_DELAY = 10_000;
const MAX_DELAY = 10 * 60_000;

/** 10 秒 → 20 秒 → … → 最大 10 分 */
export function backoff(attempts: number): number {
  return Math.min(MAX_DELAY, MIN_DELAY * 2 ** Math.max(0, attempts - 1));
}

/** 送信キュー。IndexedDB に永続化しているのでタブを閉じても残る */
export class Queue {
  constructor(private db: DB) {}

  /** 同じノートへの未処理 put / 同種の folders は積み直さない */
  async enqueue(op: QueueOp, now = Date.now()): Promise<void> {
    const tx = this.db.transaction('queue', 'readwrite');
    const all = await tx.store.getAll();
    const dup = all.find(
      (q) =>
        (op.op === 'put' && q.op === 'put' && q.ids[0] === op.ids[0]) ||
        (op.op === 'folders' && q.op === 'folders') ||
        (op.op === 'attach' && q.op === 'attach' && q.key === op.key),
    );
    if (!dup) await tx.store.add({ ...op, attempts: 0, nextAt: now } as QueueItem);
    await tx.done;
  }

  /** 先頭（FIFO）の項目。順序が意味を持つので nextAt ではなく seq 順で取る */
  async peek(): Promise<QueueItem | undefined> {
    const cursor = await this.db.transaction('queue').store.openCursor();
    return cursor?.value;
  }

  all(): Promise<QueueItem[]> {
    return this.db.getAll('queue');
  }

  async count(): Promise<number> {
    return this.db.count('queue');
  }

  async remove(seq: number): Promise<void> {
    await this.db.delete('queue', seq);
  }

  async fail(item: QueueItem, error: string, now = Date.now(), until?: number): Promise<QueueItem> {
    const attempts = item.attempts + 1;
    const next: QueueItem = { ...item, attempts, lastError: error, nextAt: until ?? now + backoff(attempts) };
    await this.db.put('queue', next);
    return next;
  }

  /** 待機中の項目を即時実行可能にする（フォアグラウンド復帰時・手動同期） */
  async wakeAll(now = Date.now()): Promise<void> {
    const tx = this.db.transaction('queue', 'readwrite');
    for (const q of await tx.store.getAll()) {
      if (q.nextAt > now) await tx.store.put({ ...q, nextAt: now });
    }
    await tx.done;
  }

  async hasPendingFor(ids: string[]): Promise<boolean> {
    const all = await this.all();
    return all.some((q) => q.ids.some((i) => ids.includes(i)));
  }
}
