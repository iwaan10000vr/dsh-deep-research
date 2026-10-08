# @dsh-external/dsh-deep-research（ローカル LLM 向けフォーク）

deep-research のワークフローを **DSH 拡張プラグイン**（skill 体系とは別物）として実装したものです。
**DSH 公式 workflow エンジン**（`exec.agent.ctx.workflowEngine` / `@deepseek-ai/dsh-workflow-workerthread`）の上で動き、
**制御論 + 情報理論**に基づいて設計されています。固定のプロンプト連鎖ではなく、**生きた適応的な研究ループ**です。

> [!IMPORTANT]
> **これは [`omdsh-dev/dsh-deep-research`](https://github.com/omdsh-dev/dsh-deep-research) のフォークです。**
> 上流との違いは「研究を直列実行する」点だけです。詳細は
> [このフォークの変更点](#このフォークの変更点ローカル-llm-向け直列化) を参照してください。

## このフォークの変更点（ローカル LLM 向け直列化）

### 何が問題だったか

上流の実装は研究ラウンドを**並列**で走らせます（`maxParallel` の既定値は `4`）。
リモート API なら妥当ですが、**手元の 1 基の GPU で動くローカルエンジン**（Strata、llama.cpp など）では破綻します。

ローカルエンジンは**一度に 1 リクエストしか処理できません**。4 件を同時に投げても高速化はせず、
後ろに並んだ 3 件はただ待たされるだけです。そして待っている間、クライアントには何も流れません。
結果として次のエラーが出ます。

```text
Failure reason: pi-ai stream idle timeout after 300000ms
```

実測したログでは、エンジン側が `serving: 1` / `queued: 10` の状態になり、
後半のリクエストが軒並み `(cancelled)` かつ `0 generated`（1 トークンも生成せず切断）で終わっていました。

さらに上流の実装には**もう 1 つ**問題がありました。`maxParallel` が 2 つの役割を兼ねていたのです。

1. **同時実行数**（`parallel()` に渡す数）
2. **1 ラウンドで消化する件数**（`pending.slice(0, maxParallel)`）

そのため `maxParallel: 1` にすると 2 も同時に 1 になり、11 件の子問題を処理するには 11 ラウンド必要になります。
一方ラウンド上限は `depth + 1`（既定で 3）なので、**大部分の子問題が静かに捨てられて**しまいます。

### どう直したか

**この 2 つの役割を分離**しました。

| 値 | 意味 | 既定 |
| --- | --- | --- |
| `maxParallel` | **同時に**走る研究者の数（`1` = 厳密な直列） | **`1`** |
| 1 ラウンドの消化数 | 保留中の**全件**（上限なし） | — |
| `maxFollowUps` | 1 ラウンドが生む補充研究の上限（研究の広さのツマミ） | `max(concurrency, 4)` |

具体的には、1 ラウンドで**キューを全部はき出し**、それを `concurrency` 件ずつの塊に切って順に待ちます。

```js
const batch = pending.slice()
for (let start = 0; start < batch.length; start += concurrency) {
  const chunk = batch.slice(start, start + concurrency)
  const got = await parallel(chunk.map(...))
  ...
}
```

これで得られる性質:

- **同時リクエストは常に 1 件** → ローカルエンジンに待ち行列ができない
- **全件を 1 ラウンドで処理** → 取りこぼしがない（ラウンド上限は補充研究のために残る）
- **合計処理時間はほぼ変わらない** → 並列化で得ていたものが元々無かったため
- `maxParallel` を上げれば従来どおり並列にもできる（リモート API を使う場合は `4` などに設定）

## 理論 → メカニズム

| 理論 | プラグインでの実装 |
| --- | --- |
| 制御論：参照信号の校正（目標を誤ると制御は無駄になる） | 計画エージェントが**答えの空間**（`scope`：何の判断・決定を支える研究か）と、各子問題の**受入基準**（`acceptance`）を先に定義してから研究を始める |
| Ashby の必要多様性の法則（制御側の多様性 < 系の多様性 ⇒ 必ず盲点が残る） | 計画エージェントが主題の**情報次元**を列挙し、各子問題を次元に対応づけ、**カバレッジ自己点検** `coverage_gaps` を出力する |
| 情報理論：情報 = 不確実性の減少 | 研究エージェントは三態の証拠 `confirmed / uncertain / gaps` を維持する（条件付きエントロピーの工学的表現）。レポートは信頼度と矛盾を保持し、不確実性を覆い隠さない |
| 情報理論：限界情報利得（EIG）の逓減 ⇒ 無限探索は誤り | 各研究エージェントは 予測 → 行動（`web_search` / `web_fetch`）→ 証拠の更新 → **限界利得の検証** を行う。**1 ラウンド連続で利得ゼロなら停止**、加えてラウンド上限 |
| 制御論：適応制御（流れは生きたもので、固定スクリプトではない） | 研究段階は**閉ループの再計画**。第 1 ラウンドで全子問題を研究し、各ラウンド終了時に high 優先度のギャップを集めて**次ラウンドの補充研究を自動で派遣**する。計画が宣言した「盲点」は**定向偵察で検証**される（仮定は静的に受け入れず実験で確かめる）。単純な主題は 1 ラウンドで収束し、複雑な主題は限界利得 ≈ 0 まで自動で拡張する |
| 情報理論：率歪み（与えられた「率」で歪みを最小化） | 統合エージェントが証拠を**非可逆圧縮**して最終レポートにする。結論を分ける情報だけを残し、意思決定に有用な形で歪みを最小化する |
| 情報理論：通信路の冗長性・誤り訂正（幻覚 = 雑音） | 任意の**対抗的レビュー**エージェント = パリティ検査。引用の抜き取り確認（URL の到達性・裏付け）、カバレッジ監査、矛盾と過信の指摘 |

## 構成

```text
dsh-deep-research/
├── package.json      # @dsh-external/dsh-deep-research（dsh.bundle.patch を宣言）
├── cordis.patch.yml  # bundle パッチ：パッケージ名でプラグイン行を挿入
├── src/index.ts      # cordis プラグイン：deep_research ツールを登録し、公式 workflow スクリプトを投入
├── lib/types/        # コンパイル済み ESM エントリ（package.json の main はこちら）
├── test/             # node --test による回帰テスト
├── tsconfig.json     # typecheck 設定（project references が sibling の deepseek-harness を解決）
└── README.md
```

## 開発と検査

```bash
pnpm install        # typescript / @types/node のみ（typecheck 用）
pnpm run typecheck  # tsc -b（型は sibling の deepseek-harness checkout から解決）
node --test         # 回帰テスト（GPU もネットワークも不要）
```

> [!NOTE]
> `tsconfig.json` は開発者側モノレポの `../../deepseek-harness/...` を参照しているため、
> 単体チェックアウトでは `tsc -b` がそのままでは通りません。その場合は
> `lib/types/index.js` を直接更新するか、`--ignoreConfig` を付けて単体ビルドしてください
> （構文が erasable-only なので、コンパイル結果はソースとほぼ一致します）。

要求される構文は **erasable-only**（`enum` / 名前空間などを使わない）です。
`node --test` と `pnpm run typecheck` が移植性のない書き方を弾きます。

## インストールと使い方

このパッケージは `dsh.bundle.patch`（`cordis.patch.yml`）を宣言しており、
`dsh plugin` で**任意の** profile に導入できます（`<profile>` は `tui` / `headless` / `web` や自作 profile）。

```bash
dsh plugin --profile <profile> add git+https://github.com/iwaan10000vr/dsh-deep-research.git
dsh --profile <profile>        # 再起動で有効化：deep_research ツールが profile に注入される
```

> pnpm が https URL を git+ssh に書き換える場合（ローカルの git `insteadof` 設定が原因）は、
> 上の `git+https://` 形式を使ってください。`allowBuilds` を求められたら、
> `$DSH_HOME/profiles/<name>/pnpm-workspace.yaml` に 1 行足します。

ツールはモデルがツール記述を見て自動的に起動します。会話では普通の言葉で指示してください。

- 「MCP エコシステムの現状を深く調査して、主要な実装を比較した引用付きのレポートを出して」
- 「この問題リストで研究して：1. ... 2. ...」（リストがある場合は自動分解を飛ばして直接研究）
- 「A/B 案を調査して。purpose はどちらを選ぶか決めるため」（用途が明確なほど答えの空間が正確になる）
- 複雑な主題は自動でラウンドが拡張され（適応的閉ループ）、単純な主題は 1 ラウンドで収束します。
  より厳密にしたい場合は `depth: 3`、引用の誤り訂正とカバレッジ監査が欲しい場合は `review: true` を渡します。

**コストの指針**：モデルの階層化。計画・統合に強いモデル、研究に安いモデルを使うと大幅に安くなります
（`plannerModel` / `researcherModel` / `synthesizerModel` / `reviewerModel` で設定）。

**依存要件**：profile の構成に公式 workflow エンジンと組み込みの web ツールが含まれている必要があります。
`dsh` 公式の base 構成には同梱されているので追加インストールは不要です。peer 依存
（`@deepseek-ai/dsh-tools` など）は構成側が提供します。profile の `autoInstallPeers: false` により、
未公開の `@deepseek-ai/*` を registry に探しに行かせずに済みます。

**更新 / 削除**:

```bash
dsh plugin --profile <profile> update
dsh plugin --profile <profile> remove @dsh-external/dsh-deep-research
# または：profile の package.json から依存を外して dsh plugin --profile <profile> update
```

## ツールのパラメータ

| パラメータ | 必須 | 説明 |
| --- | --- | --- |
| `topic` | はい | 研究主題 |
| `purpose` | いいえ | 研究の用途（支える判断・決定）。答えの空間の定義に使う。省略時は計画エージェントが仮の用途を宣言する |
| `questions` | いいえ | 既存の問題リスト（1 行に 1 つ）。渡すと自動分解を飛ばす |
| `depth` | いいえ | 精度／許容度：`1` = 初步、`2` = 深入（既定）、`3` = 窮尽。研究閉ループのラウンド上限（`depth + 1`）を決める |
| `synthesize` | いいえ | 統合エージェントが最終レポートを書く（既定 `true`）。`false` なら三態の証拠だけを返す |
| `review` | いいえ | 対抗的レビュー（既定 `false`）：引用の誤り訂正 + カバレッジ監査 + 矛盾・過信の指摘 |

## 設定（任意）

| Key | 既定 | 説明 |
| --- | --- | --- |
| `subagentProvider` | エンジン既定の `spawn` | 子エージェントの provider |
| `maxParallel` | **`1`** | **同時に**走る研究者の数。`1` = 厳密な直列（ローカルエンジン向け）。リモート API なら `4` などに上げてよい |
| `maxTotalAgents` | エンジン上限 | 1 回の実行で生む子エージェントの総数上限 |
| `plannerModel` / `researcherModel` / `synthesizerModel` / `reviewerModel` | 親の設定を継承 | モデルの階層化（計画・統合に強いモデル、実行に安いモデル） |

## 設計上の注意

- **plugin ≠ skill**：`ctx.skills` には登録しません。起動はツール記述に依存します。
- **公式機能の再利用**：オーケストレーションは公式 workflow エンジン（worker 分離、並列数・総数上限、キャンセル、進捗イベント、`wf-runs` 記録）に任せます。検索・取得は組み込みの `web_search` / `web_fetch` に任せます。プラグイン自身はネットワーク処理も独自オーケストレーションも持ちません。
- **TUI に触れない**：`tuiPrompt` / overlay / system-prompt 注入がないため、プロンプトスロットの disposed 系クラッシュを避けられます。
- **キャンセルの伝播**：`exec.signal` を workflow run に渡すため、キャンセル時に子エージェントも中止されます。
- **失敗の隔離**：個々の子問題の研究失敗はその節に注記されるだけです。計画が失敗した場合はツールがエラーを返し、呼び出し側がパラメータを変えて再試行できます。
- スキルテンプレート（`.claude/skills/deep-research`）はそのまま残してあり、両者は独立しています。

## Profile 互換性

このプラグインは実行時に DSH 公式の workflow エンジン（`workflowEngine`、peer：`@deepseek-ai/dsh-workflow`）に依存します。

**プラグインは `inject = ['tools']` しか静的に宣言しません。** Web / desktop の構成は workflow エンジンを
**意図的に Agent preset の中に隔離**しており（`delegation` グループの `isolate: workflowEngine: true`）、
ホストのルートにはそのサービスが存在しません（ルート側の `workflow-ptc` / `tool-workflow` は `disabled: true`）。
したがってホスト階層で `workflowEngine` を `inject` に書くと、そのエントリは永久に pending のままになります。
正しい方法は、呼び出し時に**呼び出し元 Agent のスコープ付きコンテキスト**から解決することです：
`exec.agent.ctx.get('workflowEngine')`（`get()` は緩い検索。未宣言でプロパティアクセサに直接触ると
`cannot get property ... without inject` を投げます）。見つからない場合は明確なエラーを返します。

実際の影響：`standard` / `ptc` など delegation グループを含む preset は使用できます。その能力を持たない preset では
「requires an Agent preset with workflowEngine」という明確なエラーになり、静かな pending やプロセス終了にはなりません。
**`workflowEngine` を `inject` に戻さないでください。** コンパイル済みの成果物（`lib/types/index.js`）が
本番のエントリで、Node からそのまま読み込めます。

## 上流との関係

- 上流：<https://github.com/omdsh-dev/dsh-deep-research>
- このフォーク：<https://github.com/iwaan10000vr/dsh-deep-research>
- 上流の README（中国語の原文）は [`README.zh-CN.md`](README.zh-CN.md) に保存してあります。

上流の改善を取り込む場合:

```bash
git remote add upstream https://github.com/omdsh-dev/dsh-deep-research.git   # 未設定なら
git fetch upstream
git merge upstream/main
```

ライセンスは MIT です（上流に準拠）。
