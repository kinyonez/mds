/** アプリ内ダイアログ（prompt / confirm / フォルダ選択）。Promise で結果を返す */

export interface DialogSpec {
  kind: 'prompt' | 'confirm' | 'folder';
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (v: string | boolean | null) => void;
}

class Dialogs {
  current = $state<DialogSpec | null>(null);

  private open<T>(spec: Omit<DialogSpec, 'resolve'>): Promise<T> {
    this.current?.resolve(null);
    return new Promise<T>((resolve) => {
      this.current = { ...spec, resolve: (v) => resolve(v as T) };
    });
  }

  prompt(title: string, opts: { message?: string; value?: string; placeholder?: string; confirmLabel?: string } = {}) {
    return this.open<string | null>({ kind: 'prompt', title, ...opts });
  }

  async confirm(title: string, opts: { message?: string; confirmLabel?: string; danger?: boolean } = {}) {
    return (await this.open<boolean | null>({ kind: 'confirm', title, ...opts })) === true;
  }

  /** 移動先フォルダの選択。'' はルート（未分類） */
  pickFolder(title: string, current = '') {
    return this.open<string | null>({ kind: 'folder', title, value: current });
  }

  close(v: string | boolean | null) {
    const c = this.current;
    this.current = null;
    c?.resolve(v);
  }
}

export const dialogs = new Dialogs();
