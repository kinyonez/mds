/** 長押し・右クリックで出すコンテキストメニュー */

export interface MenuItem {
  label: string;
  danger?: boolean;
  run: () => void;
}

class Menu {
  current = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  open(x: number, y: number, items: MenuItem[]) {
    this.current = { x, y, items };
  }

  close() {
    this.current = null;
  }
}

export const menu = new Menu();

/**
 * 長押し（タッチ）と右クリックの両方で handler を呼ぶ Svelte アクション。
 * 長押しの直後に発生する click は打ち消す。
 */
export function longpress(node: HTMLElement, handler: (x: number, y: number) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  let current = handler;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      fired = true;
      navigator.vibrate?.(10);
      current(start!.x, start!.y);
      cancel();
    }, 500);
  };
  const move = (e: PointerEvent) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  };
  const click = (e: MouseEvent) => {
    if (fired) {
      e.preventDefault();
      e.stopPropagation();
      fired = false;
    }
  };
  const context = (e: MouseEvent) => {
    e.preventDefault();
    if (fired) return;
    current(e.clientX, e.clientY);
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', click, true);
  node.addEventListener('contextmenu', context);
  node.style.setProperty('-webkit-touch-callout', 'none');
  return {
    update(h: (x: number, y: number) => void) {
      current = h;
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('click', click, true);
      node.removeEventListener('contextmenu', context);
    },
  };
}
