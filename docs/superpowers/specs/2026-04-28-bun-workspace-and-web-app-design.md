# Bun Workspace への移行と Web アプリ追加 設計書

- 日付: 2026-04-28
- 対象: ralph-railway リポジトリ全体
- ゴール: 既存 CLI を `apps/cli/` に移し、新規 SvelteKit ベースの Web アプリを `apps/web/` に追加。Bun workspace でモノレポ化する。

## 背景と目的

現在の ralph-railway は単一パッケージの CLI（`way` コマンド）として運用されている。今後、ワークフロー YAML を **保存** し、**DAG（フローチャート）として可視化** する Web UI を追加したい。実行機能は CLI 専用とし、Web 側では扱わない。

## ゴール / 非ゴール

### ゴール

- Bun workspace でモノレポ化（`apps/cli`, `apps/web`）
- 既存 CLI の挙動・publish 名（`ralph-railway` / `way`）を一切変えない
- Web アプリで以下を実現:
  - 保存済みワークフロー YAML の一覧表示
  - YAML エディタによる編集と保存（パース検証付き）
  - svelte-flow による DAG 可視化（読み取り専用 MVP）

### 非ゴール

- ワークフロー実行機能の Web 提供
- 認証 / マルチユーザ対応
- ノードのドラッグ追加・編集 GUI
- 共通コードの `packages/` 切り出し（YAGNI、必要になってから）
- packagemanager の pnpm 移行（Bun workspace を採用）

## 主要な決定事項

| 項目 | 決定 | 補足 |
|------|------|------|
| パッケージマネージャ | **Bun workspace** に統一 | `bun.lock` をモノレポ共通で保持 |
| ディレクトリ構成 | `apps/cli/` + `apps/web/` | pnpm 慣習に倣った複数形 |
| Web スタック | SvelteKit + shadcn-svelte + svelte-flow | mkazutaka 系スキルと相性◎ |
| データ層 | ローカルファイル直読み（YAML） | SvelteKit の `+server.ts` でファイル I/O をラップ |
| 共通コード | 切り出さない（YAGNI） | Web から `apps/cli/src/engine/...` を直接 import |
| DAG 描画 | `@xyflow/svelte`（svelte-flow） | dagre 等で自動レイアウト |
| YAML エディタ | `monaco-editor` または `codemirror` | 実装時に選定 |

## リポジトリ構造

```
ralph-railway/
├── apps/
│   ├── cli/                    # 既存コードの移転先
│   │   ├── src/                # 旧 ./src
│   │   ├── tests/              # 旧 ./tests
│   │   ├── package.json        # name: "ralph-railway", bin: "way"
│   │   ├── tsup.config.ts
│   │   ├── tsconfig.json
│   │   ├── biome.json          # （ルートと統合する場合は削除）
│   │   ├── README.md
│   │   └── LICENSE
│   └── web/                    # 新規 SvelteKit
│       ├── src/
│       │   ├── routes/
│       │   │   ├── +layout.svelte
│       │   │   ├── +page.svelte
│       │   │   ├── workflows/
│       │   │   │   ├── new/+page.svelte
│       │   │   │   └── [id]/
│       │   │   │       ├── +page.svelte
│       │   │   │       └── +page.server.ts
│       │   │   └── api/workflows/
│       │   │       ├── +server.ts
│       │   │       └── [id]/+server.ts
│       │   ├── lib/
│       │   │   ├── components/        # shadcn-svelte 由来
│       │   │   ├── flow/              # svelte-flow ラッパ・レイアウタ
│       │   │   └── workflow/          # YAML <-> nodes/edges マッパ
│       │   ├── app.html
│       │   └── app.css
│       ├── static/
│       ├── package.json
│       ├── svelte.config.js
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       └── tsconfig.json
├── package.json                # ルート: workspaces 定義のみ
├── bun.lock                    # モノレポ共通
├── biome.json                  # ルートで apps 配下を対象
├── tsconfig.json               # ベース設定（各 app は extends）
├── CLAUDE.md
├── README.md
└── docs/
```

## ルート package.json

```json
{
  "name": "ralph-railway-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*"],
  "scripts": {
    "cli": "bun run --cwd apps/cli cli",
    "cli:build": "bun run --cwd apps/cli build",
    "cli:test": "bun run --cwd apps/cli test",
    "web": "bun run --cwd apps/web dev",
    "web:build": "bun run --cwd apps/web build",
    "build": "bun run cli:build && bun run web:build",
    "test": "bun run cli:test",
    "lint": "biome check apps",
    "lint:fix": "biome check --write apps",
    "typecheck": "bun run --cwd apps/cli typecheck && bun run --cwd apps/web check",
    "check": "bun run lint && bun run typecheck && bun run test"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.12"
  },
  "engines": {
    "node": ">=20",
    "bun": ">=1.1"
  }
}
```

## apps/cli/package.json

既存の `package.json` をほぼそのまま移植する。変更点のみ列挙:

- `exports` フィールドを追加し、Web から内部モジュールを import 可能にする:

```json
"exports": {
  ".": "./dist/cli.js",
  "./engine": "./src/engine/index.ts",
  "./workflow-paths": "./src/workflow-paths.ts"
}
```

- `bin: { "way": "./dist/cli.js" }` 維持（npm publish 名前不変）
- `files: ["dist", "README.md", "LICENSE"]` 維持
- 既存スクリプト（`cli`, `build`, `test`, `lint`, `typecheck`, `check`, `prepublishOnly`, `release`）は変更なし

注意: Web 側は Vite ビルドなので `./src/*.ts` を直接参照可能（Node ランタイム上の publish パッケージとしては `dist` が本体）。`apps/cli/src/engine/index.ts` が無ければ作成する。

## apps/web/package.json（骨子）

```json
{
  "name": "@ralph-railway/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json"
  },
  "dependencies": {
    "ralph-railway": "workspace:*"
  },
  "devDependencies": {
    "@sveltejs/adapter-node": "^5.x",
    "@sveltejs/kit": "^2.x",
    "@sveltejs/vite-plugin-svelte": "^4.x",
    "svelte": "^5.x",
    "svelte-check": "^4.x",
    "vite": "^5.x",
    "@xyflow/svelte": "^0.1.x",
    "tailwindcss": "^3.x",
    "bits-ui": "^0.x",
    "tailwind-variants": "^0.x",
    "js-yaml": "^4.x"
  }
}
```

## Web アプリの仕様（MVP）

### ルーティング

| パス | 役割 |
|------|------|
| `/` | 保存済みワークフロー一覧（カード表示） |
| `/workflows/new` | 新規 YAML（テンプレ）から作成 |
| `/workflows/[id]` | 編集・DAG 表示画面 |
| `/api/workflows`（GET） | 一覧 JSON |
| `/api/workflows`（POST） | 新規作成（body: name + yaml） |
| `/api/workflows/[id]`（GET/PUT/DELETE） | 単一 YAML の取得・更新・削除 |

### ファイル I/O

- 環境変数 `RALPH_WORKFLOWS_DIR`（デフォルト: リポジトリルートの `./.agents/railways`）以下の `.yaml` / `.yml` を対象
- `+server.ts` 内で `fs/promises` 使用
- 保存前に `apps/cli/src/engine` のパーサで検証、失敗時は 400 を返す
- セキュリティ: id は `path.basename` 化、拡張子は `.yaml` / `.yml` のみ許可（パストラバーサル対策）

### 編集画面

- レイアウト: 左ペイン YAML エディタ、右ペイン DAG ビュー
- YAML エディタ: monaco または codemirror
- DAG ビュー: `@xyflow/svelte`、エディタ変更を 300ms debounce で再パース→再描画
- 保存: 上部「Save」ボタンで PUT、パース失敗時はエラートースト
- ノードクリックで右下に当該 step の詳細を読み取り表示（MVP）

### YAML → DAG マッピング

- `apps/cli/src/engine` のパーサで `Workflow` オブジェクトに変換
- step を順序つきの node に変換、`then` / `branches` などの遷移を edge に変換
- 自動レイアウト: `dagre` で縦方向ランクづけ（後で svelte-flow 標準 layout に差し替え可）

### スタイル

- Tailwind CSS + shadcn-svelte（bits-ui + tailwind-variants）
- ダーク/ライト切替は将来

## 移行手順（高レベル）

1. ルート `package.json` を新仕様で書き換え（旧 ralph-railway 内容は退避）
2. ルート `.gitignore` 更新（`apps/*/node_modules`, `apps/*/dist`, `apps/web/.svelte-kit` など）
3. 既存ファイルを `apps/cli/` に git mv:
   - `src/`, `tests/`, `tsup.config.ts`, `tsconfig.json`, `biome.json`, `package.json`, `README.md`, `LICENSE`
4. `apps/cli/package.json` に `exports` を追加、import パス修正（必要なら）
5. ルート `biome.json` / `tsconfig.json` を再構築（apps 配下を対象に）
6. `.github/workflows/` を `apps/cli` 基準に修正（publish, CI のパス）
7. ルートの `dist/`, `node_modules/`, `ralph-railway-0.0.1.tgz` を削除
8. `bun install` で workspace lock を再生成
9. `bun run check` がグリーンであることを確認
10. `apps/web/` を SvelteKit + Tailwind + shadcn-svelte で scaffold
11. svelte-flow + YAML エディタ導入、API ルート実装、DAG マッピング実装
12. `bun run web` でローカル起動、サンプル YAML（`.agents/railways/example-coding-workflow.yaml` 等）を読み込み・保存・DAG 表示できることを確認

## テスト方針

- CLI 側: 既存の `bun test` を `apps/cli/` 内でそのまま実行（変更なし）
- Web 側: MVP は手動動作確認のみ。自動テストは将来追加
- ルートの `bun run check` で CLI の lint + typecheck + test が通ること
- Web の `svelte-check`（型チェック）が通ること

## 互換性

- npm publish される `ralph-railway` パッケージの内容（`dist/cli.js`, README, LICENSE）は不変
- `npx ralph-railway` / `way` コマンドの動作は不変
- 既存開発者は再 `bun install` が必要（`bun.lock` がモノレポ統一になるため）
- `.agents/`, `.claude/`, `docs/` などのメタ情報はルート維持

## リスクと対応

| リスク | 影響 | 対応 |
|--------|------|------|
| publish 経路（GH Actions）の破損 | 自動リリース停止 | 手順 6 で CI のパス更新を必須に。ローカルで `bun run cli:build` の dist 内容を移行前後で diff |
| Web の Vite ビルドが Bun と相性問題を起こす | 開発体験悪化 | `apps/web` 内では `bun --bun vite dev` または通常の Node 経由 `vite` の両方を試せるよう script を分ける |
| YAML パーサの web 側利用で型解決が破綻 | typecheck 失敗 | `apps/cli/src/engine/index.ts` を barrel として整備し、`exports` 経由で参照 |
| svelte-flow のバージョン互換 | DAG 描画不能 | `@xyflow/svelte` の現行最新を pin。Svelte 5 対応バージョンを採用 |

## 範囲外（明示）

- ワークフロー実行機能の Web 提供
- 認証・権限・マルチテナント
- ノードのドラッグ追加・編集 GUI
- 共通コードの `packages/` 切り出し
- pnpm への移行
- Web の自動 E2E / 単体テスト整備
