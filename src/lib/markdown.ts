import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

export interface LinkResolver {
  /** [[ID]] の表示名。削除済み・不明なら null */
  title(id: string): string | null;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function wikiLinks(md: InstanceType<typeof MarkdownIt>, resolver: LinkResolver) {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src.slice(state.pos);
    const m = /^\[\[([0-9A-HJKMNP-TV-Z]{26})(?:\|([^\]]*))?\]\]/.exec(src);
    if (!m) return false;
    if (!silent) {
      const id = m[1];
      const resolved = resolver.title(id);
      const label = m[2] || resolved || id;
      const open = state.push('wikilink_open', 'a', 1);
      open.attrSet('href', `#/note/${id}`);
      open.attrSet('data-note-link', id);
      if (resolved == null) open.attrSet('class', 'broken-link');
      const t = state.push('text', '', 0);
      t.content = label;
      state.push('wikilink_close', 'a', -1);
    }
    state.pos += m[0].length;
    return true;
  });
}

export function createRenderer(resolver: LinkResolver) {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
  wikiLinks(md, resolver);
  // 外部リンクは新しいタブで開く
  const defaultOpen = md.renderer.rules.link_open ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const hrefAttr = String(tokens[idx].attrGet('href') ?? '');
    if (/^https?:/.test(hrefAttr)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
    }
    return defaultOpen(tokens, idx, opts, env, self);
  };
  return (body: string): string =>
    // サニタイズを必ず通す
    DOMPurify.sanitize(md.render(body), { ADD_ATTR: ['target', 'data-note-link'] });
}

/** ../attachments/<id>/<file> 形式の相対パスを分解する */
export function parseAttachmentSrc(src: string): { noteId: string; filename: string } | null {
  const m = /^(?:\.\.\/)?attachments\/([^/]+)\/([^/?#]+)$/.exec(src);
  if (!m || !ULID.test(m[1])) return null;
  return { noteId: m[1], filename: decodeURIComponent(m[2]) };
}
