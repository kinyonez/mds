import { normalizeFolder, normalizeTags, nowIso } from './note';
import type { NoteMeta } from './frontmatter';

/** テンプレート固有の front matter キー（テンプレートのノート自身にだけ書く） */
export const TEMPLATE_FOLDER_KEY = 'templateFolder';
export const TEMPLATE_TITLE_KEY = 'templateTitle';

export interface TemplateValues {
  title: string;
  folder: string;
  tags: string[];
  body: string;
}

/** {{date}} {{time}} {{title}} を展開する */
export function expandPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
}

/**
 * テンプレートから新しいノートの初期値を作る。
 * フォルダはテンプレートの指定を優先し、無ければ今表示中のフォルダ。タグは両方の和集合。
 */
export function expandTemplate(
  tpl: { meta: NoteMeta; body: string },
  ctx: { folder?: string; tags?: string[]; now?: Date } = {},
): TemplateValues {
  const iso = nowIso(ctx.now);
  const vars: Record<string, string> = { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  const title = expandPlaceholders(String(tpl.meta[TEMPLATE_TITLE_KEY] ?? ''), vars);
  vars.title = title;
  let folder = ctx.folder ?? '';
  const tf = tpl.meta[TEMPLATE_FOLDER_KEY];
  if (typeof tf === 'string' && tf.trim()) {
    try {
      folder = normalizeFolder(tf);
    } catch {
      /* 使えないフォルダ名なら今のフォルダのまま */
    }
  }
  return {
    title,
    folder,
    tags: normalizeTags([...(tpl.meta.tags ?? []), ...(ctx.tags ?? [])]),
    body: expandPlaceholders(tpl.body, vars),
  };
}
