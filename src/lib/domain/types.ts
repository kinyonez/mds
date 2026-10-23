/** index.json の 1 ノート分 */
export interface IndexNote {
  id: string;
  path: string;
  sha: string;
  title: string;
  folder: string;
  tags: string[];
  created: string;
  updated: string;
  excerpt: string;
  links: string[];
  error?: string;
  trashedAt?: string;
  trashedFrom?: string;
}

/** Actions が生成する index.json */
export interface NotesIndex {
  version: number;
  generatedAt?: string;
  commit?: string;
  folders: string[];
  tags: Record<string, number>;
  notes: IndexNote[];
}

export const EMPTY_INDEX: NotesIndex = { version: 1, folders: [], tags: {}, notes: [] };

/** UI が扱うノートのメタデータ（index + ローカル未反映分を重ねたビュー） */
export interface NoteSummary {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  created: string;
  updated: string;
  excerpt: string;
  links: string[];
  error?: string;
  trashedAt?: string;
  trashedFrom?: string;
  /** ローカルにだけある変更を含む */
  local: boolean;
}
