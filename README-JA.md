# HogAgent

[English](README.md) · [简体中文](README-CN.md) · [日本語](README-JA.md)

HogAgent は金融リサーチに最適化された汎用 AI エージェントエンジンです。モデルの推論、ツール、Skills を組み合わせて調査、分析、ファイル作成を実行し、ブラウザー UI とアプリケーション統合用の JSONL RPC を提供します。

- **公式サイト：**[ciweiai.com/hogagent.html](https://ciweiai.com/hogagent.html)
- **金融データソースとツール：**[Hedgehog Skills](https://github.com/hedgehog-finance/hedgehog-skills/)
- **バージョン：**`1.2.4` · **ライセンス：**[GPL-3.0](LICENSE)

## 主な機能

- **タスク実行：**Quick、Standard、Long Task の各モード。長時間タスクは計画、チェックポイント、監査、再開に対応します。監査の可用性と判定はタスクの完了状態とは別に記録されます。
- **ツールと Skills：**ファイル操作、シェル、数値計算、Web 検索とページ取得。8 つの組み込み Skill は、スキル作成、金融計算、チャート、プレゼンテーション、文書変換、表計算、テクニカル指標、企業評価を扱います。
- **拡張：**コンテンツ圧縮、サブエージェント、成果物管理、ファイル配信、永続メモリ、外部 MCP サービス。コンテンツ圧縮は既定で無効です。
- **モデル：**複数のプロバイダーと独自の OpenAI 互換エンドポイントに対応し、メインモデルと監査モデルを個別に設定できます。
- **Web UI：**ストリーミング対話、履歴、ユーザーとワークスペースの選択、モデル設定、Skills、ツール、テーマ、ファイルプレビュー。
- **アプリケーション統合：**stdin/stdout の JSONL コマンドとイベント、セッション永続化、自動コンテキスト圧縮、プロセス・セッション・実行単位のコンテキスト。Gateway は認証済みプロジェクトの関連付けとメタデータを管理します。

Pi Agent Harness は `src/vendor/` に含まれます。HogAgent は単独で、または HedgehogGateway、IDE プラグインなどの子プロセスとして動作します。

## インストールと実行

macOS、Linux、Windows と **Node.js >= 22.19.0** が必要です。シェル経由の Python 処理には、使用可能な Python インタープリターと `venv` が必要です。

```bash
git clone https://github.com/hedgehog-finance/HogAgent.git
cd HogAgent
npm install
npm run build

# ブラウザー UI：http://localhost:9108
node dist/bin/hogagent-web.js --port 9108 --workspace /absolute/path/to/workspace

# ターミナル対話
node dist/bin/hogagent.js --mode interactive --user default --workspace /absolute/path/to/workspace

# アプリケーション統合
node dist/bin/hogagent.js --mode rpc --user default --session example --workspace /absolute/path/to/workspace
```

起動コマンドはリポジトリのルートで個別に実行してください。`/absolute/path/to/workspace` は実際の絶対パスに置き換え、空白を含む場合は引用符で囲みます。メッセージ送信前に有効な API キーを設定してください。Web UI の起動だけならキーは不要です。Web UI は Ctrl+C、ターミナル対話は `/exit` で終了します。既存のモノレポでは `hogagent/` に移動し、クローンを省略します。

Web UI または `~/.hogagent/llm-settings.json` でモデルを設定します。

```json
{
  "provider": "hedgehog",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.ciweiai.com/api/llm/v1",
  "modelId": "qwen3.8-flash"
}
```

モデル名はプロバイダーが提供するものを指定してください。検索設定は `~/.hogagent/search_settings.json`、金融データの認証情報は `~/.hogagent/skills_config.json` 内の各 Skill の `api-key` に保存します。単独実行と Gateway 管理下の実行は、この設定ディレクトリを共有します。

## ワークスペースと実行環境

`--workspace` でユーザーのワークスペースを指定します。対応関係は `~/.hogagent/user_settings.json`、会話履歴は `~/.hogagent/sessions/<ユーザーディレクトリ>/` に保存されます。指示は `AGENTS.md`、`.hogagent/hogagent.md` の順に読み込み、ワークスペースの Skills は `.hogagent/skills/` に配置します。

シェルの隔離は `~/.hogagent/hogagent.json` の `sandboxMode` で設定します。macOS/Linux では `enabled` が OS サンドボックスを必須とし、`fallback` は初期化失敗時の隔離なし実行を許可します。既定の `disabled` は OS 隔離を行いません。Windows のシェルも隔離なしで動作します。詳しくは[ツールの権限](docs/tools.md)を参照してください。

## 開発と評価

```bash
npm run check
npm test -- --run
npm run build
npm run test:readme
```

`npm run test:readme` は API キーなしでビルド済みの起動方法と RPC サンプルを検証します。環境、実際のモデルでの確認範囲と制限は[リリース検証記録](docs/release-validation.md)を参照してください。

[RPC サンプル](examples/README.md)で統合方法を確認できます。[FinanceGym](FinanceGym/README.md)には、`qwen3.8-flash` の `standard` モードによるテスト条件、最終レポート、20 問の問題文と回答レポートを収録しています。

## ドキュメント

| ガイド | 内容 |
|---|---|
| [アーキテクチャ](docs/architecture.md) | ランタイム、タスク実行、コンポーネント境界 |
| [デプロイ](docs/deployment.md) | インストールと運用 |
| [設定](docs/configuration.md) | モデル、検索、共有設定、ワークスペース |
| [RPC プロトコル](docs/orchestrator-integration.md) | コマンド、イベント、実行コンテキスト |
| [ツール](docs/tools.md) / [Skills](docs/skills.md) | ツール引数とスキル開発 |
| [拡張](docs/extensions.md) / [外部 MCP](docs/external-mcp.md) | 拡張 API と外部サービス |
| [成果物](docs/artifact-manifest.md) | ファイル分類と配信 |
| [Web UI](docs/web-ui.md) | 対話、設定、ファイルプレビュー |
| [開発](docs/development.md) / [トラブルシューティング](docs/troubleshooting.md) | ビルド、テスト、診断 |
