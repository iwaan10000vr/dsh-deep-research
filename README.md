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

## このフォークの変更点 2（`workflowEngine` に届くようにする）

**上流の配置では、このプラグインは動きませんでした。**

workflow エンジンは preset の `delegation` グループに `isolate: workflowEngine: true` で隔離されており、
**同じ分離領域にいる利用者しか見えません**。プラグイン同梱のパッチはホスト直下に行を挿入するため、
`ctx.get('workflowEngine')` が空になり、呼び出しは必ず失敗していました。

```text
deep_research requires an Agent preset with workflowEngine
```

実際にこの状態では、モデルが `deep_research` を諦めて**組み込みの `workflow` ツールで13並列を手組み**していました
（エンジンは 1 件ずつしか処理しないため、後半が待ち行列でタイムアウトし全件失敗）。

**修正は 2 点です。**

1. **プラグイン側**：エンジンを**自分の ctx 優先**で解決する（上のコード）。`delegation` グループ内に置けば同じ分離領域になり、正しく見えます
2. **profile 側**：ホスト直下の行を無効化し、`preset-standard` を上書きして `delegation` グループの内側に配置する

詳細と設定例は [Profile 互換性](#profile-互換性重要正しい配置) を参照してください。

## このフォークの変更点 3（ローカル向けに実行時間を短縮する）

**実測: 1 回の研究が 3 時間 15 分かかりました**（研究者 28 体、リクエスト 301 件、入力 1,000 万
トークン）。ローカルでは研究者の数がそのまま直列時間になるため、次の 3 点を直しました。

| 問題（実測） | 修正 | 効果 |
| --- | --- | --- |
| 研究者が 15 体で第1ラウンド 105 分（全体の 54%） | `maxQuestions: 8`（計画と `questions` の両方に適用） | 約 56 分 |
| 補充研究が毎回ちょうど 4 体で情報利得により収束せず、ラウンド上限まで走った（12 体 = 57 分） | `maxFollowUps: 2` | 約 30 分 |
| 統合レポートが 24,000 トークン出力（11 分） | 長さの上限（1,500〜3,000 字）を指示 | 数分 |
| 呼び出し側の `questions` に指示文が混じり、その各行が研究者になった | 指示文を質問とみなさない | 1 行あたり約 7 分 |
| 27 体分の生の証拠をレポートに同梱し、親のコンテキストを圧迫した | 同梱をやめ、件数と所在の 1 行だけ返す | 親のコンテキスト −12,491 トークン |

**見込み: 195 分 → 70〜80 分**（約 60% 削減）。詳細な数字は
[ローカル向けの実行時間](#ローカル向けの実行時間実測に基づく調整) を参照してください。

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
| `questions` | いいえ | 既存の問題リスト（1 行に 1 つ）。渡すと自動分解を飛ばす。**指示文（`【…】` で始まる行や「〜せよ」で終わる行）は質問とみなさず除外します**（下記） |
| `depth` | いいえ | 精度／許容度：`1` = 初步、`2` = 深入（既定）、`3` = 窮尽。研究閉ループのラウンド上限（`depth + 1`）を決める |
| `synthesize` | いいえ | 統合エージェントが最終レポートを書く（既定 `true`）。`false` なら三態の証拠をそのまま返す |
| `review` | いいえ | 対抗的レビュー（既定 `false`）：引用の誤り訂正 + カバレッジ監査 + 矛盾・過信の指摘 |

> [!IMPORTANT]
> **`synthesize: true`（既定）の戻り値は圧縮されたレポート本文だけです。**
> 各研究者の三態の証拠（confirmed / uncertain / gaps）は同梱しません。証拠が必要なときは、
> UI でその研究者のサブエージェントを開くか、`synthesize: false` で呼んでください。
> 件数と所在はレポート末尾の1行に記載されます。

## 進捗の見方と中止（観測面）

`deep_research` は**前景で実行**され、メインエージェントは完走まで何も見えません（実測で 3 時間
15 分の「盲管」でした）。そこで **DSH の正規の観測面であるジョブ**に進捗を写しています。

実行すると 1 つの `deep-research` ジョブが作られ、戻り値に `jobId` が入ります。

| 見る手段 | 内容 |
| --- | --- |
| **セッションヘッダのジョブ一覧** | フェーズ見出しと研究者の開始/終了が**ライブで流れる**。進捗線は現在のフェーズを示す |
| `job_output` | 同じ内容を後から読める。長い実行の途中経過もここに残る |
| `job_list` | 実行中のジョブと状態（running / completed / killed / failed） |
| `job_kill` | **安全な中止。** `cancel()` が `AbortController` を中断し、エンジンへ渡した signal が abort される |

出力は次の形で流れます。

```text
== 研究·第1轮 ==
  > #1 研究1·第1轮 開始
  v #1 completed
  > #2 研究2·第1轮 開始
  ...
== 综合 ==
完了
```

**中止しても一貫して決着します。** ジョブは `killed` になり、ツールは「実行が cancelled だった」
というエラーを返します（中途半端なレポートは返りません）。失敗時も同様に必ずジョブが決着するので、
「実行中」のまま残るジョブはありません。

**どちらの実行経路でも同じように見えます。** `'workflow'` はエンジンのイベントを購読して写し、
`'continuable'` はホストが進捗を直接ジョブへ書きます。`job_output` / `job_kill` の使い方は
変わりません。

### 実行中の研究者に指示を出す（`researchMode: 'continuable'` のみ）

研究が走っている間、その研究者は**サブエージェント一覧に常駐**しています。開いて送ると
`next-step` で届き、次の一手から反映されます。

```
1. サブエージェント一覧で実行中の研究者（例: 研究3·第1轮）を開く
2. メッセージを送る（Queue = 次のターン / Steer = 次のステップ）
3. 研究者は「追加指示を受け取りました」と応答してから作業を続ける
```

**役に立つ注文の例:** 調査範囲の指定（「江戸期は除外して昭和に絞れ」）、解釈の決定
（「統計は国勢調査を基準にしろ」）、除外の指示（「このサイトは一次資料ではないので使うな」）。

研究者が**こちらに質問してくる**こともあります。判断が必要な曖昧さに当たった場合で、
そのときは同じ画面に返信してください。**回答を待って止まることはありません** — 回答に
依存しない部分を進め、解決できなかった点は `uncertain` / `gaps` に残します。

> [!NOTE]
> `jobs` サービスが無い構成では**ミラーせず従来どおり動きます**（研究は成功し、進捗表示だけが
> ありません）。ジョブ作成に失敗した場合も同様で、理由はプラグインのログに出ます。

## 設定（任意）

| Key | 既定 | 説明 |
| --- | --- | --- |
| `subagentProvider` | エンジン既定の `spawn` | 子エージェントの provider |
| `maxParallel` | **`1`** | **同時に**走る研究者の数。`1` = 厳密な直列（ローカルエンジン向け）。リモート API なら `4` などに上げてよい |
| `maxQuestions` | **`8`** | 子問題の上限（計画の出力と呼び出し側の `questions` の両方に効く）。**ローカルでは実行時間の最大のレバー** |
| `maxFollowUps` | **`2`** | 1 ラウンドが生む補充研究の上限。大きいと情報利得で収束せずラウンド上限まで走る |
| `researcherRounds` | **`2`** | 各研究者が内部で回す探索ラウンドの上限（`depth: 1` では 1 固定） |
| `maxTotalAgents` | エンジン上限 | 1 回の実行で生む子エージェントの総数上限（`workflow` 経路のみ） |
| `researchMode` | **`'workflow'`** | 実行経路。`'continuable'` にすると研究者が常駐し、**実行中に UI から指示（Steer）を届けられます**（下記） |
| `continuableRetries` | `1` | `'continuable'` のとき、JSON 回収に失敗した子を作り直す回数（ローカルでは 1 回 ≒ 数分） |
| `plannerModel` / `researcherModel` / `synthesizerModel` / `reviewerModel` | 親の設定を継承 | モデルの階層化（計画・統合に強いモデル、実行に安いモデル） |

### 実行経路の選択（`researchMode`）

| | `'workflow'`（既定） | `'continuable'` |
| --- | --- | --- |
| 実装 | 公式 workflow エンジン | ホストが子を直接回す |
| **実行中の指示** | **不可**（子は one-shot） | **可能**（子が常駐し `next-step` で届く） |
| 子の質問 | 不可 | **可能**（`send_message` で親に聞ける） |
| 構造化出力 | `outputSchema` で強制 | JSON を回収して検証（失敗は作り直し） |
| 実績 | 安定・長時間の実測あり | 実機検証済み（下記） |

**`'workflow'` が既定なのは安全側の選択です。** 実測で分かっている事実として、
エンジンが作る研究者は **one-shot で steer できません**（子のプロンプトに親への
`send_message` 指示が無く、`next-step` への挿入も起きない）。実行中に注文を付けたい
ときだけ `'continuable'` を選んでください。

### `'continuable'` の実機検証（2026-10-09）

フェーズ0（PoC）と実機の研究で、次を確認しました。

| 項目 | 実測 |
| --- | --- |
| `startContinuable` → `whenIdle` で完了が取れる | **OK**（+1.4〜5.2 秒。待機中に events が 7→24 に増えた＝開始前に活動が登録される） |
| 常駐枠の解放（`drainContinuableChildren`） | **OK — 9 体連続で成功**（上限 8 を突破） |
| 子の最終出力の抽出 | **OK**（`output(6)=POC-OK`） |
| **実行中の子への Steer** | **OK** — `agent/inbox/spliced target=next-step` で届き、子が「追加指示を受け取りました」と応答して方針を変えた |
| 研究者が continuable で作られる | **OK** — `origin=subagent depth=2` かつ `send_message` 指示あり（workflow 経路では無し＝steer 不可） |
| 双方向質問 | **OK** — 子が「判断が必要な曖昧さが2点あります」と親へ質問し、**回答を待たずに完遂**（`whenIdle` が正常に返った） |
| ジョブミラー（この経路でも進捗が見える） | **OK** — `== 规划 ==` `> 研究1·第1轮 開始  子 4e3edd8d-…` が job に流れた |

**研究者に指示を送るには、進捗に出る `子 <childId>` を使います。** 実行中の研究者は
UI のサブエージェント一覧にも出ます。

`'continuable'` の性質:

- **子は質問できます。** 判断が必要な曖昧さ（範囲の取り方、互換な解釈の選択など）に
  当たると `send_message` で親に聞きます。**回答を待って空転はしません** — 回答に
  依存しない部分を続け、解決できなかった点は `uncertain` / `gaps` に入れます（事実と
  して断定しない）。
- **常駐枠を漏らしません。** 各子は完了・失敗・例外のいずれでも破棄されます（枠は
  既定 8。実測で 9 体連続の作成と破棄を確認済み）。
- **出力の検証は緩めません。** JSON を回収できない、またはスキーマに合わない子は
  作り直し、それでもダメなら**その子問題の失敗として報告に明記**します（壊れた値を
  黙って混ぜません）。

### ローカル向けの実行時間（実測に基づく調整）

**リモート API なら不要ですが、手元の 1 基の GPU では実行時間がそのまま問題になります。**
実測（RTX 5060 Ti 16GB + 125B モデル、直列）では次のようになりました。

| 段階 | 件数 | 所要 | 全体比 |
| --- | ---: | ---: | ---: |
| 研究 第1ラウンド | 15 | **105 分** | **54%** |
| 研究 第2〜4ラウンド | 12 | 57 分 | 29% |
| 総合 | 1 | 11 分 | 6% |
| 審査 | 1 | 3 分 | — |
| **合計** | 28 | **約 195 分** | |

**分かったこと:**

1. **研究者の数がそのまま時間です**（直列なので 1 件 ≒ 7 分）。第1ラウンドが 15 件だったため
   全体の 54% を占めました → `maxQuestions: 8` で約 56 分に。
2. **補充研究が自己増殖していました。** 旧既定の `maxFollowUps: 4` では第2〜4ラウンドが
   **毎回ちょうど 4 件**になり、情報利得で自然収束せずラウンド上限まで走り切りました
   （3 ラウンド × 4 件 = 12 件 ≒ 57 分）→ `maxFollowUps: 2` で抑制。
3. **総合が 24,000 トークンを出力**していました → レポートに長さの上限（1,500〜3,000 字）を指示。

**現在の既定での見込み: 70〜80 分**（195 分から約 60% 削減）。
短くしたいときは `maxQuestions` を下げるのが最も効きます。逆に品質を優先するなら `depth: 3` と
`maxQuestions` を上げてください（その分だけ時間が増えます）。

### 質問リストの衛生

呼び出し側が `questions` に**指示文を混ぜた**場合、それを質問として扱いません。
実測で次の逸脱がありました。

```text
你的子问题：【方法制約】web_search はAPIキー未設定で必ずエラーになる。呼び出さず…   ← 指示（除外）
你的子问题：距離は中心点からhaversineで計算せよ。                                ← 指示（除外）
你的子问题：岡崎空襲の被害規模と軍事的理由は何か。                                ← 質問（研究する）
```

行単位で分割する設計なので、指示文の各行が独立した研究者になり、**1 行あたり約 7 分**を
無駄にしていました。次の形は質問とみなしません。

- `【…】` や `##` で始まる行（節見出し・指示）
- 「〜せよ / 〜するな / 〜を使え / 〜が有効」など命令形で終わり、疑問形でない行
- 200 文字を超える行（質問ではなく指示の塊。実測の逸脱は 400 字超）

除外した行数は `planText` に明示されるので、意図しない縮小には気づけます。

## 前提: `web_search` の API キー（重要）

このプラグイン自身はネットワークに触りません。検索は DSH 組み込みの `web_search` に任せます。
そして **`web_search` は `DEEPSEEK_API_KEY` を必要とします**（プロバイダは
`@deepseek-ai/dsh-web-search-deepseek`）。キーが無いと検索は**必ず失敗**します。

実測での影響は深刻でした。ある実行（岡崎 10km 圏の歴史調査、4.5 時間・研究者 27 体）では、
研究者自身がプロンプトにこう書き込んで回避していました。

```text
【方法制約】web_search はAPIキー未設定で必ずエラーになる。呼び出さず、
検索は web_fetch で https://html.duckduckgo.com/html/?q=QUERY を使い…
```

つまり `web_fetch` で検索エンジンを叩く回り道をしており、**品質と速度の両方を損ねて**いました
（最終レポート自身が「web_search が APIキー欠如で全ラウンド失敗」を情報缺口として明記しています）。

**設定方法**（いずれか）:

1. DSH の設定画面で `web_search` の資格情報を保存する（`ctx.credentials` 経由で参照されます）
2. `$DSH_HOME/.credentials.yaml` に `DEEPSEEK_API_KEY` を記録する
3. プロセス環境変数 `DEEPSEEK_API_KEY` を設定する

**確認方法**: キーが有効なら、研究者のプロンプトに上のような回避指示が現れません。あるいは
`web_search` を直接呼んで、API キー不足のエラーが出ないことを確かめてください。

> [!TIP]
> キーが無い環境でも研究は動きます（`web_fetch` にフォールバックするため）。ただし検索の
> 到達範囲が狭まり、時間もかかります。ローカルで回すなら設定しておく価値があります。

## 設計上の注意

- **plugin ≠ skill**：`ctx.skills` には登録しません。起動はツール記述に依存します。
- **公式機能の再利用**：オーケストレーションは公式 workflow エンジン（worker 分離、並列数・総数上限、キャンセル、進捗イベント、`wf-runs` 記録）に任せます。検索・取得は組み込みの `web_search` / `web_fetch` に任せます。プラグイン自身はネットワーク処理も独自オーケストレーションも持ちません。
- **TUI に触れない**：`tuiPrompt` / overlay / system-prompt 注入がないため、プロンプトスロットの disposed 系クラッシュを避けられます。
- **キャンセルの伝播**：`exec.signal` を workflow run に渡すため、キャンセル時に子エージェントも中止されます。
- **失敗の隔離**：個々の子問題の研究失敗はその節に注記されるだけです。計画が失敗した場合はツールがエラーを返し、呼び出し側がパラメータを変えて再試行できます。
- スキルテンプレート（`.claude/skills/deep-research`）はそのまま残してあり、両者は独立しています。

## Profile 互換性（重要：正しい配置）

このプラグインは実行時に DSH 公式の workflow エンジン（`workflowEngine`、peer：`@deepseek-ai/dsh-workflow`）に依存します。

**workflow エンジンは Agent preset の中に `isolate` で隔離されています。** `standard` / `ptc` / `cordis` preset は次のように宣言しています。

```yaml
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true      # ← この分離領域の中だけが見える
  config:
    - id: workflow-ptc        # エンジンの提供側
    - id: tool-workflow       # 同じ領域内の利用者なので見える
```

`isolate` は「提供側と、**同じ分離領域にいる利用者**をまとめて隔離する」仕組みです。したがって：

- **ホスト直下に置くと動きません。** ホストのルートにはこのサービスが存在せず（ルート側の `workflow-ptc` / `tool-workflow` は `disabled: true`）、
  `ctx.get('workflowEngine')` は空になります。
- **プラグインは `delegation` グループの内側に置いてください。** そうして初めて同じ分離領域に入り、エンジンが見えます。

### profile 側の設定

プラグイン同梱の `cordis.patch.yml` はホスト直下に行を挿入するだけなので、**それだけでは動きません**。profile の
`cordis.patch.yml` で次の 2 点を行う必要があります（この手順は当リポジトリの利用環境で実際に検証済みです）。

```yaml
# 1) ホスト直下の行は無効化する（エンジンが見えず、必ず失敗するため）
- id: dsh-deep-research
  disabled: true

# 2) preset を丸ごと上書きし、delegation グループの内側に置く
#    ※ パッチの `config` は深いマージをせず「置換」なので、preset の全行を書き直す必要があります
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # ...（省略：バンドル内の preset-standard の内容をそのまま）...
      - id: delegation
        name: cordis:group
        group: true
        isolate:
          workflowEngine: true
        config:
          - id: workflow-ptc
            name: '@deepseek-ai/dsh-workflow-ptc'
            config:
              provider: spawn
          - id: tool-workflow
            name: '@deepseek-ai/dsh-tool-workflow'
          - id: deep-research                      # ← これを追加
            name: '@dsh-external/dsh-deep-research'
          # ...（残りの行）...
```

> [!WARNING]
> `config` は**置換**であってマージではありません。preset を上書きする場合、その preset の行を**すべて**書き直す必要があります。
> DSH を更新して preset に行が追加された場合は、このブロックを再生成してください（古いままだと新しい行が失われます）。

### コード側の解決順序

プラグインは**自分の ctx を優先**してエンジンを解決します。これにより、`delegation` グループ内に置かれたときに正しく動きます。

```js
const workflowEngine = ctx.get('workflowEngine') ?? parent.ctx.get('workflowEngine')
```

1. **自分の ctx** — `delegation` グループ内に置かれた場合（推奨・実績あり）。同じ分離領域なので見える
2. **呼び出し元 Agent の ctx** — ホスト直下に置いた場合のフォールバック

どちらでも見つからない場合は、**正しい配置を名指しするエラー**を返します（静かな pending やプロセス終了にはなりません）。
`get()` は緩い検索です（未宣言でプロパティアクセサに直接触ると `cannot get property ... without inject` を投げます）。
**`workflowEngine` を静的な `inject` に戻さないでください。**

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
