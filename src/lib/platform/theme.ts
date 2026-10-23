/** テーマ（ライト / ダーク / システム）。UI 状態なので localStorage に置く */
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'mds.theme';

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* ストレージ不可 */
  }
  return 'system';
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ストレージ不可 */
  }
  applyTheme(t);
}

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  // ステータスバーの色をテーマに合わせる
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.content = dark ? '#0d1117' : '#ffffff';
    m.removeAttribute('media');
  }
}

export function initTheme() {
  applyTheme(getTheme());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getTheme()));
}

/** フォルダの開閉状態など、リポジトリに入れない UI 状態 */
export function loadUi<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`mds.${key}`);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveUi(key: string, value: unknown) {
  try {
    localStorage.setItem(`mds.${key}`, JSON.stringify(value));
  } catch {
    /* ストレージ不可 */
  }
}
