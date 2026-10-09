/**
 * dsh-deep-research — Deep Research orchestrator extension for DeepSeek Harness.
 *
 * A REAL plugin (not a skill): registers one model-facing tool, `deep_research`,
 * that runs the user's deep-research workflow ON TOP OF DSH'S OFFICIAL WORKFLOW
 * ENGINE (`exec.agent.ctx.workflowEngine`, `@deepseek-ai/dsh-workflow-workerthread`) — no custom
 * subagent plumbing, no TUI surface, no prompt injection.
 *
 * The pipeline is a LIVE ADAPTIVE LOOP designed from cybernetics + information
 * theory — it is NOT a fixed four-stage prompt chain:
 *
 * ── 问题定义 (control theory: reference-signal calibration) ────────────────
 *   The planner first defines the ANSWER SPACE (`scope`: what decision the
 *   report supports) and per-question acceptance criteria, so the loop never
 *   chases a mis-set reference.
 *
 * ── 多样性拆解 (Ashby's Law of Requisite Variety) ──────────────────────────
 *   The planner enumerates the topic's information DIMENSIONS, maps each
 *   sub-question to a dimension, and self-audits COVERAGE (`coverage_gaps`):
 *   uncovered dimensions are declared as hypotheses to be tested, not hidden.
 *
 * ── 自适应研究循环 (adaptive control / perception–action cycle) ────────────
 *   Research is an ITERATIVE CLOSED LOOP, not a one-shot fan-out:
 *     round 1:  all planned sub-questions in parallel.
 *     round n>1: dynamic re-planning — high-priority gaps reported by the
 *                previous round become NEW sub-questions, and the planner's
 *                declared blind spots get one reconnaissance attempt (a
 *                planning assumption is verified experimentally, not trusted).
 *   Convergence is information-theoretic: the loop stops when a round produces
 *   no new high-priority gaps (marginal information gain ≈ 0) or the round cap
 *   (depth + 1) is hit. Simple topics converge after one round; hard ones
 *   automatically expand — the flow is alive, not a fixed script.
 *   Each researcher keeps a three-state evidence model (confirmed / uncertain /
 *   gaps = conditional entropy made explicit) and stops internally the moment
 *   one round adds nothing.
 *
 * ── Integration / synthesis (rate–distortion) ──────────────────────────────
 *   The final report is lossy compression for a stated decision: it keeps only
 *   information that distinguishes conclusions, and PRESERVES uncertainty
 *   (confidence / contradictions / verified blind spots) instead of masking it.
 *
 * ── Review (channel redundancy / error correction, opt-in) ─────────────────
 *   An adversarial reviewer acts as a parity check: citation spot-checks
 *   (hallucinated sources = channel noise), coverage audit against the declared
 *   dimensions, contradiction and over-confidence marking.
 *
 * Model tiering (OpenAI guide) via config: `plannerModel` / `researcherModel` /
 * `synthesizerModel` / `reviewerModel` → `args.models`; omitted models inherit
 * the parent route. The plugin never fetches the web: search/fetch stays on
 * DSH's built-in `web_search` / `web_fetch`, which children inherit.
 *
 * Native TypeScript source: the package entry points at this file and no build
 * step exists. In a dsh profile the package lives under node_modules, so it
 * loads through the dsh source launcher's whole-process tsx hook (Node's
 * native type stripping refuses files under node_modules); a checkout run
 * outside node_modules can also load via Node >=22.18 native stripping.
 * Syntax must stay erasable-only (no enums/namespaces/parameter properties).
 *
 * @module @dsh-external/dsh-deep-research
 */
import type { Context } from 'cordis';
export declare const name = "dsh-deep-research";
/** Activate once the tool registry is available; each calling Agent supplies its scoped workflow engine. */
export declare const inject: string[];
/** Plugin config (all optional). */
export interface Config {
    /** Child-provider override passed to every workflow run. */
    subagentProvider?: string;
    /** Role-level model overrides, one per planner/researcher/synthesizer/reviewer role. */
    plannerModel?: string;
    researcherModel?: string;
    synthesizerModel?: string;
    reviewerModel?: string;
    /** Per-run total-child ceiling for every workflow run. */
    maxTotalAgents?: number;
    /**
     * How many researchers may run at the SAME TIME (default 1 = strictly serial).
     * A local engine (Strata, llama.cpp, ...) serves one request at a time, so
     * raising this only queues siblings — it does not speed them up, and the ones
     * at the back can hit the client's idle-stream timeout while they wait.
     */
    maxParallel?: number;
    /**
     * 計画段階が出してよい子問題の上限（既定 8）。
     *
     * ローカルエンジンでは研究者の数がそのまま所要時間になる（直列なので1件≒7分）。
     * 実測: 15 件で第1ラウンドだけで 105 分かかり、全体 195 分の 54% を占めた。
     * 上限を下げると比例して短くなる。超えた分は捨てずに**切り詰め**（後述）、
     * 重要度の高い次元が残るよう計画プロンプトで優先順位を明示している。
     */
    maxQuestions?: number;
    /**
     * 1ラウンドが生む補充研究の上限（既定 2）。研究の広さのツマミ。
     *
     * 実測: 旧既定 4 では第2〜4ラウンドが毎回ぴったり 4 件になり、情報利得で
     * 自然収束せずラウンド上限まで走り切った（合計 12 件 = 約 57 分）。
     * 2 にすると補充は絞られ、上限に当たる前に収束しやすくなる。
     */
    maxFollowUps?: number;
    /**
     * 各研究者が自分の中で回す探索ラウンドの上限（既定 2）。
     * depth が 1 のときは 1。研究者1件あたりの所要（実測 平均 6.7 分）に効く。
     */
    researcherRounds?: number;
    /**
     * 一時的な検証用: true で `poc_continuable` ツールを登録する。
     * continuable な子のライフサイクル（完了検出・出力取得・スロット解放）を
     * 実機で確かめるための使い捨て経路。検証が終わったらこのフラグごと削除する。
     */
    poc?: boolean;
    /**
     * `deep_research` の実行経路（既定は `'workflow'`）。
     *
     * - `'workflow'`   : 公式 workflow エンジン。安定・実績あり。ただし子は
     *                    one-shot なので、**実行中に人間が研究者へ注文できない**。
     * - `'continuable'`: ホストが continuable な子を直接回す。研究者が常駐するので
     *                    UI の Steer / `send_message` が `next-step` で届く（実測済み）。
     *                    代償として outputSchema が使えず、出力は
     *                    `recoverStructuredOutput` で回収・検証する。
     *
     * 既定を `'workflow'` にしているのは、新しい経路が「追加の検証で目的を達成した」
     * と確認できるまでの安全側の選択。
     */
    researchMode?: 'workflow' | 'continuable';
    /**
     * `researchMode: 'continuable'` のとき、構造化出力の回収に失敗した子を
     * 何回まで作り直すか（既定 1 = 最大 2 回試行）。
     *
     * ローカルでは 1 回の再試行が数分の追加コストになるため、0（再試行しない）も
     * 選べる。検証は緩めないので、失敗した子の結果は下流に混ざらない。
     */
    continuableRetries?: number;
}
/** Planner structured output: answer space + dimension coverage + questions. */
export declare const PLANNER_SCHEMA: {
    type: string;
    additionalProperties: boolean;
    properties: {
        scope: {
            type: string;
        };
        dimensions: {
            type: string;
            items: {
                type: string;
            };
        };
        questions: {
            type: string;
            items: {
                type: string;
                additionalProperties: boolean;
                properties: {
                    question: {
                        type: string;
                    };
                    dimension: {
                        type: string;
                    };
                    keywords: {
                        type: string;
                    };
                    acceptance: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
        coverage_gaps: {
            type: string;
            items: {
                type: string;
            };
        };
    };
    required: string[];
};
/** Researcher structured output: the three-state evidence model (entropy tracking). */
export declare const RESEARCHER_SCHEMA: {
    type: string;
    additionalProperties: boolean;
    properties: {
        confirmed: {
            type: string;
            items: {
                type: string;
                additionalProperties: boolean;
                properties: {
                    claim: {
                        type: string;
                    };
                    source: {
                        type: string;
                    };
                    confidence: {
                        type: string;
                        enum: string[];
                    };
                };
                required: string[];
            };
        };
        uncertain: {
            type: string;
            items: {
                type: string;
                additionalProperties: boolean;
                properties: {
                    point: {
                        type: string;
                    };
                    reason: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
        gaps: {
            type: string;
            items: {
                type: string;
                additionalProperties: boolean;
                properties: {
                    aspect: {
                        type: string;
                    };
                    priority: {
                        type: string;
                        enum: string[];
                    };
                };
                required: string[];
            };
        };
    };
    required: string[];
};
/** Apply the plugin: register the `deep_research` tool on `ctx.tools`. */
export declare function apply(ctx: Context, config?: Config): void;
/**
 * 子のイベント列（activation boundary 以降）から最終出力テキストを選ぶ。
 *
 * AssistantOutputFold.collect() と同じ規則:
 *   1. 最後の非空 `assistant/message` の本文
 *   2. それが無ければ `assistant/message` / `assistant/attempt` の stream を連結
 *   3. どちらも無ければ空文字
 *
 * continuable な子は `outputSchema` を持てない（ContinuableStartSpec が
 * 構造的に除外している）ため、子の出力の解釈はこちら側の責任になる。
 * 単体で検証できるよう export している（cordis の plugin 契約は name/inject/apply）。
 */
export declare function extractFinalAssistantText(events: readonly unknown[]): string;
/**
 * テキストから最初の完全な JSON オブジェクトを取り出す。
 *
 * 子は説明文やコードフェンスを前後に付けがちなので、素朴な `JSON.parse` では
 * 落ちる。次の順に試す:
 *   1. ```json … ``` / ``` … ``` のフェンス内
 *   2. 波括弧の対応を数えて最初の完全な `{…}` を切り出す（文字列リテラル内の
 *      波括弧とエスケープを正しく飛ばす）
 *   3. 全文そのもの
 *
 * @returns 解析できた値。できなければ `undefined`。
 */
export declare function extractJsonValue(text: string): unknown;
/**
 * このプラグインが使う範囲の JSON Schema 検証（object / array / string /
 * number / integer / boolean / enum / required / additionalProperties）。
 *
 * DSH の `assertObjectJsonSchema` は `dsh-tools` の内部で、ここからは参照
 * できないため、必要な部分だけを持つ。**検証は緩めない**方針: 型が違えば
 * 失敗にし、子の出力を勝手に補正しない（補正は誤りを隠す）。
 */
export declare function checkSchema(schema: unknown, value: unknown, path?: string): string[];
/**
 * 子の最終出力から、スキーマに合う JSON オブジェクトを回収する。
 *
 * 子は `outputSchema` を持てないので、ここが唯一の担保になる。抽出に失敗した
 * 場合と検証に落ちた場合を区別して返し、呼び出し側が再試行や失敗扱いを選べる
 * ようにする（黙って部分的に使うことはしない）。
 */
export declare function recoverStructuredOutput(events: readonly unknown[], schema: unknown): {
    ok: true;
    value: Record<string, unknown>;
    text: string;
} | {
    ok: false;
    errors: string[];
    text: string;
};
//# sourceMappingURL=index.d.ts.map