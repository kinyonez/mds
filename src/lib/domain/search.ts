import MiniSearch from 'minisearch';

// 日本語（かな・漢字）は bigram、英数字は単語単位でトークン化する
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ々〆ー]+/gu;
const WORD = /[\p{L}\p{N}_]+/gu;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const s = text.normalize('NFKC').toLowerCase();
  for (const m of s.matchAll(CJK)) {
    const run = [...m[0]];
    if (run.length === 1) out.push(run[0]);
    for (let i = 0; i + 1 < run.length; i++) out.push(run[i] + run[i + 1]);
  }
  for (const m of s.replace(CJK, ' ').matchAll(WORD)) out.push(m[0]);
  return out;
}

export interface SearchDoc {
  id: string;
  title: string;
  text: string;
}

export class SearchIndex {
  private ms = this.create();
  private docs = new Map<string, SearchDoc>();

  private create() {
    return new MiniSearch<SearchDoc>({
      fields: ['title', 'text'],
      storeFields: [],
      tokenize,
      processTerm: (t) => t,
      searchOptions: {
        boost: { title: 3 },
        prefix: (term) => /^[a-z0-9_]/.test(term),
        combineWith: 'AND',
        tokenize,
        processTerm: (t) => t,
      },
    });
  }

  /** 同じ id があれば差し替える（excerpt → 本文の順で上書きしていく） */
  upsert(doc: SearchDoc): void {
    const prev = this.docs.get(doc.id);
    if (prev && prev.title === doc.title && prev.text === doc.text) return;
    if (prev) this.ms.discard(doc.id);
    this.ms.add(doc);
    this.docs.set(doc.id, doc);
  }

  remove(id: string): void {
    if (!this.docs.has(id)) return;
    this.ms.discard(id);
    this.docs.delete(id);
  }

  ids(): string[] {
    return [...this.docs.keys()];
  }

  reset(docs: SearchDoc[]): void {
    this.ms = this.create();
    this.docs.clear();
    this.ms.addAll(docs);
    for (const d of docs) this.docs.set(d.id, d);
  }

  search(query: string): { id: string; score: number }[] {
    if (!query.trim()) return [];
    // 1 文字の CJK クエリは bigram に当たらないので、prefix 検索でカバーする
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    return this.ms
      .search(query, {
        prefix: (term) => /^[a-z0-9_]/.test(term) || [...term].length === 1,
      })
      .map((r) => ({ id: String(r.id), score: r.score }));
  }
}
