# mds

GitHub のプライベートリポジトリをストレージにした、個人用 Markdown メモアプリ（PWA）。
アプリ本体は GitHub Pages から配信し、PC・スマートフォンとも同じ URL をブラウザで開いて使う。
サーバーは持たず、ブラウザが GitHub REST API を直接叩く。

## 構成

| リポジトリ | 公開範囲 | 中身 |
| --- | --- | --- |
| このリポ（mds） | 公開 | アプリのソース。`main` への push で GitHub Pages にデプロイ |
| notes-data | プライベート | メモ本体（`notes/<ULID>.md`）、`_meta/folders.json`、Actions が生成する `index.json` |

```
src/
  lib/domain/    front matter の解析と直列化、正規化、ツリー導出、検索（MiniSearch + bigram）
  lib/store/     IndexedDB（notes / base / index / queue / attachments / settings）と送信キュー
  lib/sync/      GitHub API クライアント、同期エンジン、3-way マージ
  lib/platform/  トークン暗号化（PBKDF2 + AES-GCM）、テーマ、visualViewport
  components/ views/  Svelte 5 の UI（3 ペイン、スマホは 1 ペインずつ）
data-template/   notes-data に置くファイル（ワークフロー、build-index.mjs、ひな形）
tests/           同期エンジン・ドメイン・build-index のテスト（GitHub API はインメモリのモック）
```

## セットアップ

1. **アプリの配信**: このリポの Settings → Pages → Source を「GitHub Actions」にする。`main` に push すると `.github/workflows/deploy.yml` がビルドしてデプロイする。
2. **データリポ**: プライベートリポ `notes-data` を README 付きで作成する（空のリポには API でコミットできない）。
3. **トークン**: [Fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) を発行する。
   - Repository access: Only select repositories → `notes-data` のみ
   - Permissions: Contents: Read and write
4. アプリを開き、設定画面でリポジトリ（`owner/notes-data`）、トークン、パスフレーズを入力して「接続テスト」→「ひな形を作成」→「保存して接続」。
5. ワークフロー `.github/workflows/index.yml` は Workflow 権限が要るため、設定画面のリンクから GitHub 上で作成する（内容は入力済みで開く）。

## 開発

```sh
npm install
npm run dev      # 開発サーバー
npm test         # テスト（同期エンジンの 5 シナリオほか）
npm run check    # 型チェック
npm run build    # dist/ に PWA をビルド
```

アイコンは `node scripts/make-icons.mjs` で `public/` に再生成できる。
