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
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'dsh-deep-research';
/** Activate once the tool registry is available; each calling Agent supplies its scoped workflow engine. */
export const inject = ['tools'];
/** Planner structured output: answer space + dimension coverage + questions. */
export const PLANNER_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        scope: { type: 'string' },
        dimensions: {
            type: 'array',
            items: { type: 'string' },
        },
        questions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    question: { type: 'string' },
                    dimension: { type: 'string' },
                    keywords: { type: 'string' },
                    acceptance: { type: 'string' },
                },
                required: ['question', 'dimension'],
            },
        },
        coverage_gaps: {
            type: 'array',
            items: { type: 'string' },
        },
    },
    required: ['scope', 'dimensions', 'questions', 'coverage_gaps'],
};
/** Researcher structured output: the three-state evidence model (entropy tracking). */
export const RESEARCHER_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        confirmed: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    claim: { type: 'string' },
                    source: { type: 'string' },
                    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
                required: ['claim', 'source'],
            },
        },
        uncertain: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    point: { type: 'string' },
                    reason: { type: 'string' },
                },
                required: ['point'],
            },
        },
        gaps: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    aspect: { type: 'string' },
                    priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
                required: ['aspect'],
            },
        },
    },
    required: ['confirmed'],
};
/**
 * The workflow script. STATIC TEXT — no template interpolation: all dynamic
 * input rides `args` (topic, purpose, questions, depth, flags, models,
 * maxParallel), and the body uses string concatenation only, so there is no
 * `\${` escaping and no injection surface. The EXECUTION is adaptive: the
 * research phase re-plans itself round by round until information saturation.
 * Runs in the official engine's worker thread.
 */
const SCRIPT = String.raw `const PLANNER_SCHEMA = ${JSON.stringify(PLANNER_SCHEMA)}
const RESEARCHER_SCHEMA = ${JSON.stringify(RESEARCHER_SCHEMA)}
const { topic, questions, depth, synthesize, review, models, purpose, maxParallel,
        maxQuestions, maxFollowUps, researcherRounds, questionsDropped } = args
const M = models ?? {}
// 研究者が自分の中で回す探索ラウンド。depth 1 は浅く、それ以外は指定値。
const LIMIT = depth === 1 ? 1 : (Number(researcherRounds) || 2)
// concurrency = how many researchers run AT THE SAME TIME (1 = strictly serial).
// It is deliberately separate from how many questions a round DRAINS: a local
// engine serves one request at a time, so queueing four siblings does not make
// them faster, it only makes the ones at the back wait (and idle-timeout).
const concurrency = Math.max(1, Number(maxParallel) || 1)
// 1ラウンドが生む補充研究の上限。研究の広さのツマミであって同時実行のツマミではない
// （直列化しても適応的な再計画を殺さないため）。ローカルでは小さいほど早く終わる。
const followUpCap = Math.max(1, Number(maxFollowUps) || 2)
// 計画が出してよい子問題の上限。ローカルでは研究者の数＝所要時間なので、
// ここが実行時間の最大のレバー。超過分は捨てず、次元の広い方から残す。
const questionCap = Math.max(1, Number(maxQuestions) || 8)

function confidenceLabel(c) {
  return c === 'high' ? '高' : c === 'medium' ? '中' : c === 'low' ? '低' : '中'
}

function renderFindings(q, f) {
  const lines = ['## ' + q.question, '']
  if (f.confirmed && f.confirmed.length > 0) {
    lines.push('### 確認できた事実（確度）')
    for (const item of f.confirmed) {
      lines.push('- ' + item.claim + '（確度：' + confidenceLabel(item.confidence) + '、出典：' + item.source + '）')
    }
  }
  if (f.uncertain && f.uncertain.length > 0) {
    lines.push('### 不確実な点')
    for (const item of f.uncertain) {
      lines.push('- ' + item.point + (item.reason ? '（理由：' + item.reason + '）' : ''))
    }
  }
  if (f.gaps && f.gaps.length > 0) {
    lines.push('### 情報の欠落（優先度）')
    for (const item of f.gaps) {
      lines.push('- ' + item.aspect + '（優先度：' + confidenceLabel(item.priority) + '）')
    }
  }
  if (!f.confirmed || f.confirmed.length === 0) lines.push('（この子問題について確認できる証拠は得られなかった）')
  return lines.join('\n')
}

phase('計画')
let subs = Array.isArray(questions) && questions.length > 0 ? questions : null
let planText = ''
if (subs) {
  // 呼び出し側が渡した質問にも上限を適用（ここを素通しすると行数ぶん走る）。
  if (subs.length > questionCap) {
    planText = '（呼び出し側の子問題 ' + subs.length + ' 件を、ローカル実行のため ' + questionCap + ' 件に絞った）'
    subs = subs.slice(0, questionCap)
  }
  if (Number(questionsDropped) > 0) {
    planText += (planText ? '\n' : '') + '（指示文とみなした ' + Number(questionsDropped) + ' 行は研究対象から除外した）'
  }
}
if (!subs) {
  const planned = await agent(
    'You are the planner for a deep research task. The first step of research is to define the question itself: '
    + 'first fix the answer space, then decompose it into subquestions along information dimensions.\n\n'
    + 'Research topic: ' + topic
    + (purpose ? '\nIntended use (the decision or judgment this must support): ' + purpose : '')
    + '\n\nWork in this order:\n'
    + '1. [Answer space] Define scope in one sentence: what this research answers, and what judgment or decision it supports. If no use was given, state the use you are assuming.\n'
    + '2. [Information dimensions] Enumerate the information dimensions of the topic space (for example: background and current state, key technologies or mechanisms, main actors and ecosystem, data and scale, trends and outlook, controversies and risks, policy and regulation, comparative analysis -- pick what fits the topic). These become the baseline for the later coverage check.\n'
    + '3. [Diverse decomposition] Map at least one subquestion to each dimension (law of requisite variety: if the set of subquestions does not cover every dimension of the topic space, blind spots are guaranteed). For each subquestion give: its dimension, search keyword leads (in both English and the local language), and an acceptance criterion (what would count as answering it).\n'
    + '   **Hard limit on the total number of subquestions: ' + questionCap + '** (an environment constraint: the local inference engine studies them one at a time, roughly 7 minutes each). '
    + 'So **order them by importance** and put the dimensions that best support the answer space first; dimensions beyond the limit go into coverage_gaps instead of becoming subquestions.\n'
    + '4. [Coverage assumptions] List coverage_gaps: dimensions you cannot cover with subquestions, or where information may be extremely hard to obtain. These are actually verified in later rounds -- if the information turns out to be available, extra research is dispatched automatically; if it is genuinely unavailable, it is written into the report as a verified blind spot.\n\n'
    + 'Output JSON only. Write no other text and no Markdown code fences.',
    {
      label: '計画',
      phase: '計画',
      schema: PLANNER_SCHEMA,
      ...(M.planner ? { model: M.planner } : {}),
    },
  )
  if (!planned || !Array.isArray(planned.questions) || planned.questions.length === 0) {
    throw new Error('the planner agent returned no usable subquestions')
  }
  subs = planned.questions
  const dims = Array.isArray(planned.dimensions) ? planned.dimensions : []
  const gaps = Array.isArray(planned.coverage_gaps) ? planned.coverage_gaps : []
  planText = '調査の答えの空間：' + (planned.scope || '（未宣言）')
    + '\n覆う次元：' + (dims.length > 0 ? dims.join('、') : '（未宣言）')
    + (gaps.length > 0 ? '\n計画が仮定した盲点（未検証）：' + gaps.join('、') : '')
  // 盲点の偵察も子問題として調査キューに入れる。ただし全体を questionCap で抑える:
  // ローカルでは研究者1体 ≒ 7分の直列時間なので、ここが実行時間の最大のレバー。
  // 溢れた分は捨てず、計画の順序（重要度順に作られている想定）を保って切り詰める。
  const room = Math.max(1, questionCap - subs.length)
  subs = subs.concat(gaps.slice(0, room).map((g) => ({ question: g, dimension: '盲点の偵察', blind: true })))
  if (subs.length > questionCap) {
    planText += '\n（ローカル実行のため子問題を ' + questionCap + ' 件に絞った。元 ' + (subs.length) + ' 件）'
    subs = subs.slice(0, questionCap)
  }
}

phase('研究')
const researcherPrompt = (q, round, isFollowUp) => {
  const header = isFollowUp
    ? 'This is follow-up research, round ' + round + ', targeting the high-priority gaps the previous round exposed: '
    : (q.blind
      ? 'This is a targeted scout of a blind-spot hypothesis from planning. Verify whether public information on the following is genuinely scarce (if it truly is, say so in gaps rather than inventing something): '
      : 'Your subquestion: ')
  return 'You are a deep-research subagent. Your job is not to "search as much as possible": the criterion is '
    + 'maximum information gain. Drive the conditional uncertainty about your subquestion down to an acceptable level, then stop immediately.\n\n'
    + 'Research topic: ' + topic + '\n' + header + q.question
    + (q.dimension && !q.blind ? '\nDimension: ' + q.dimension : '')
    + (q.keywords ? '\nSearch keyword leads: ' + q.keywords : '')
    + (q.acceptance ? '\nAcceptance criterion (what counts as answered): ' + q.acceptance : '')
    + '\n\nSearch with the built-in web_search tool (if web_fetch is in your tool set, fetch specific pages when needed; otherwise rely on web_search alone). Use no tools other than web_search / web_fetch.\n\n'
    + 'Perception-action loop (follow it strictly every round):\n'
    + 'Step 0: write your current best answer from existing knowledge, however incomplete.\n'
    + 'Step 1 [Predict]: list the 1-3 highest-entropy uncertainties. Pick the query with the highest expected information gain (EIG) and write one sentence: which uncertainty it targets, what new information you expect, and how a contrary result would change your answer.\n'
    + 'Step 2 [Act]: run that query (try keywords in both the local language and English; fetch key pages with web_fetch if you have it).\n'
    + 'Step 3 [Update]: sort the new evidence into three states: confirmed (facts backed by reliable sources) / uncertain (weak or mutually contradictory judgments) / gaps (information still missing, tagged with priority high/medium/low).\n'
    + 'Step 4 [Verify marginal gain]: answer whether this round added any confirmed items, and whether it changed or overturned any earlier conclusion.\n\n'
    + 'Stop criteria (information-theoretic; stop when any one holds, and search no further):\n'
    + '- the previous round\'s marginal gain was zero (nothing newly confirmed, no conclusion changed);\n'
    + '- all high-priority gaps are cleared;\n'
    + '- the hard round limit is reached (at most ' + LIMIT + ' rounds).\n\n'
    + 'Source assessment: authority (prefer government, academic and industry bodies), recency (prefer the last 3 years), reliability (backed by citations or data). '
    + 'Confidence tiers: A government / academic / international bodies; B industry associations / corporate white papers; C specialist media; D personal blogs / self-published media. '
    + 'List only sources you actually visited. Prefer not confirming over fabricating -- anything you cannot confirm goes into uncertain or gaps.\n\n'
    + 'Output JSON only (write no other text):\n'
    + 'confirmed array (each: claim, source URL, confidence high/medium/low); '
    + 'uncertain array (each: point, reason); '
    + 'gaps array (each: aspect, priority high/medium/low).'
}

// ── 自适应研究闭环 ──────────────────────────────────────────────────────────
const results = {}
const rounds = []
let pending = subs.slice()
let round = 0
while (pending.length > 0 && round < depth + 1) {
  round += 1
  phase('研究・第' + round + 'ラウンド')
  // Drain the WHOLE queue this round, but never run more than concurrency
  // researchers at once. A round therefore covers every pending question in
  // order; nothing is deferred to a later round (the round cap is spent on
  // follow-ups, not on leftovers), and no sibling sits idle waiting for the
  // engine while the client's stream timeout runs down.
  const batch = pending.slice()
  const found = []
  for (let start = 0; start < batch.length; start += concurrency) {
    const chunk = batch.slice(start, start + concurrency)
    const got = await parallel(chunk.map((q, i) => () => agent(researcherPrompt(q, round, round > 1), {
      label: '研究' + (start + i + 1) + '・第' + round + 'ラウンド',
      phase: '研究・第' + round + 'ラウンド',
      schema: RESEARCHER_SCHEMA,
      ...(M.researcher ? { model: M.researcher } : {}),
    })))
    for (let i = 0; i < chunk.length; i += 1) found[start + i] = got[i]
  }
  batch.forEach((q, i) => {
    if (found[i]) results[q.question] = found[i]
  })
  rounds.push(batch.map((q, i) => ({ q, f: found[i] })))

  // 収束の評価：このラウンドの high-priority の欠落を集め、次のラウンドの補充研究にする。
  // Follow-up leads are bounded by maxFollowUps (a research-breadth knob),
  // NOT by concurrency (how many run side by side).
  const leads = []
  const seen = new Set()
  for (const item of batch) {
    const f = results[item.question]
    if (!f || !Array.isArray(f.gaps)) continue
    for (const g of f.gaps) {
      if (g.priority !== 'high') continue
      if (seen.has(g.aspect) || leads.length >= followUpCap) continue
      seen.add(g.aspect)
      leads.push({ question: g.aspect, followUp: true })
    }
  }
  pending = leads
  // キューの意味：このラウンドで待ち行列の子問題をすべて調べ終えたので、次は
  // high-priority の欠落だけが補充問題として残る。新しい high-priority の欠落が
  // 無ければ、ループは自然に終わる（限界利得がゼロ）。
}

const ordered = []
const seenQ = new Set()
for (const batch of rounds) {
  for (const { q, f } of batch) {
    if (seenQ.has(q.question)) continue
    seenQ.add(q.question)
    ordered.push({ q, f })
  }
}
const parts = []
let okCount = 0
for (const { q, f } of ordered) {
  if (f) okCount += 1
  parts.push(f ? renderFindings(q, f) : '## ' + q.question + '\n\n> この子問題の調査は失敗した（子エージェントが構造化された証拠を返さなかった）')
}
const totalRounds = rounds.length
const intermediate = '# ' + topic + ' — 深い調査の中間結果（証拠の状態）\n\n> 子問題 ' + ordered.length
  + ' 件、完了 ' + okCount + ' 件、調査ラウンド ' + totalRounds + ' 回。'
  + (planText ? '\n\n' + planText : '') + '\n\n' + parts.join('\n\n---\n\n')

let report = intermediate
if (synthesize) {
  phase('統合')
  const final = await agent(
    'You are a top-tier industry analyst. Your output is a single lossy compression: under the constraint of report length (rate), keep only the information that discriminates between final conclusions, maximizing decision usefulness (minimizing distortion).\n\n'
    + 'Report topic: ' + topic
    + (purpose ? '\nIntended use (the decision or judgment this must support): ' + purpose : '')
    + (planText ? '\n' + planText : '')
    + '\n\nReport structure:\n## Summary (3-5 sentences of core conclusions, including an overall confidence assessment)\n## 1. Background\n## 2. Key findings (organized by dimension; each item carries confidence and a source citation)\n## 3. Uncertainty and contradictions (state plainly which conclusions have low confidence and which sources contradict each other -- uncertainty is itself important information and must be preserved, not masked)\n## 4. Information gaps and verified blind spots (what actually happened to the blind spots planning assumed)\n## 5. Conclusions and recommendations (the best judgment the evidence supports, with the strength of that evidence marked)\n## 6. References'
    + '\n\nRequirements: cite source URLs inline for every key piece of information; distinguish fact (high confidence) from inference (low confidence); present contradictory information side by side; use tables or comparisons where the data suits it; avoid generalities; state plainly where evidence is thin rather than inventing it. Markdown format.\n'
    + '**Length constraint (important):** this is lossy compression, not a compilation. Target 1,500-3,000 characters; 1-3 sentences per point; put in a table what fits in a table; list citations as URLs without restating source content; do not repeat evidence details. Prefer short and decidable over long and diluted.\n\nBelow is what the research found:\n\n' + intermediate,
    {
      label: '統合',
      phase: '統合',
      ...(M.synthesizer ? { model: M.synthesizer } : {}),
    },
  )
  // 証拠の全文をレポートに同梱しない。同梱すると 27 件分の生証拠が親の
  // コンテキストにそのまま入り、実測で 12,491 トークンを占めていた
  // （親が 91,917 = 上限の 70% まで膨らみ、400 エラーの瀬戸際になった）。
  // 研究の設計上、成果物は統合レポートであって証拠の山ではない。証拠は
  // 各研究者のセッションに残っており、UI から開けばいつでも読める。
  if (final) {
    report = final
      + '\n\n---\n\n> 証拠の状態：子問題 ' + ordered.length + ' 件、完了 ' + okCount + ' 件'
      + (ordered.length > okCount ? '、失敗 ' + (ordered.length - okCount) + ' 件' : '')
      + '、調査ラウンド ' + totalRounds + ' 回。各子問題の三態の証拠（confirmed / uncertain / gaps）は'
      + '対応する研究子エージェントのセッションに残っている。細部が必要なときはその子エージェントの対話を直接開いてほしい（本報告では繰り返さない）。'
  }
}

let reviewText = null
if (review) {
  phase('審査')
  reviewText = await agent(
    'You are the reviewer for a research report. Your role is channel error correction: audit the report adversarially and find the noise and errors in its chain of evidence. '
    + 'If web_fetch is in your tool set, spot-check whether suspicious source URLs actually resolve and whether their content supports the citation; otherwise assess source credibility from what web_search returns.\n\n'
    + 'Audit dimensions:\n'
    + '1. Citation errors: does the URL fail to resolve, or is it unrelated to the conclusion? Does the citation actually support the claim? (A hallucinated source is channel noise and must be flagged.)\n'
    + '2. Coverage audit: against the information dimensions planning declared, which dimensions have thin or entirely missing evidence? (Ashby\'s law of requisite variety: a missing dimension means the controller lacks variety, i.e. a blind spot.)\n'
    + '3. Contradictions: where sources conflict, is the conflict marked and preserved?\n'
    + '4. Recency: is key data stale?\n'
    + '5. Overconfidence: is any low-confidence conclusion stated as established fact?\n'
    + (planText ? '\nWhat planning declared:\n' + planText : '')
    + '\n\nOutput the review only (Markdown). Do not rewrite the report itself:\n## Review\n### Suspicious sources (if any)\n### Coverage blind spots (if any)\n### Contradictions\n### Overconfident items\n### Highest-priority gaps for further research (if any, for the next targeted round)\n### Overall assessment and suggested corrections'
    + '\n\nReport topic: ' + topic + '\n\nReport under review:\n\n' + report,
    {
      label: '審査',
      phase: '審査',
      ...(M.reviewer ? { model: M.reviewer } : {}),
    },
  )
  if (reviewText) reviewText = '## 敵対的審査の意見\n\n' + reviewText
}

return {
  report,
  review: reviewText,
  rounds: totalRounds,
  subquestions: ordered.length,
  completed: okCount,
  failed: ordered.length - okCount,
}
`;
/** 実行中の workflow run id → その run を映すジョブ。 */
const runJobs = new Map();
function runIdOf(info) {
    const id = info?.id;
    return typeof id === 'string' ? id : String(id ?? '');
}
/** workflow/* を購読してジョブに写す。apply() から 1 回だけ呼ぶ。 */
function mirrorWorkflowIntoJobs(ctx) {
    // イベント名の型（Context の `Events` 拡張）は @deepseek-ai/dsh-workflow が
    // 提供するが、このチェックアウトは peer 依存を解決しないため見えない。
    // 実行時は文字列で正しく動く（tool-workflow も同じ名前を使っている）。
    const on = ctx.on;
    on('workflow/phase', (info, title) => {
        const job = runJobs.get(runIdOf(info));
        if (job === undefined)
            return;
        job.updateProgress(String(title));
        job.append('== ' + String(title) + ' ==\n');
    });
    on('workflow/log', (info, message) => {
        runJobs.get(runIdOf(info))?.append(String(message) + '\n');
    });
    on('workflow/agent-start', (info, agent) => {
        const job = runJobs.get(runIdOf(info));
        if (job === undefined)
            return;
        const a = agent;
        const label = a.label === undefined ? '' : String(a.label);
        const phase = a.phase === undefined ? '' : String(a.phase) + ' - ';
        job.append('  > #' + String(a.seq) + ' ' + label + ' 開始\n');
        job.updateProgress(phase + label);
    });
    on('workflow/agent-end', (info, agent) => {
        const a = agent;
        runJobs.get(runIdOf(info))?.append('  v #' + String(a.seq) + ' ' + String(a.outcome ?? '') + '\n');
    });
}
/** Apply the plugin: register the `deep_research` tool on `ctx.tools`. */
export function apply(ctx, config = {}) {
    mirrorWorkflowIntoJobs(ctx);
    const subagentProvider = config.subagentProvider ?? undefined;
    const plannerModel = config.plannerModel ?? undefined;
    const researcherModel = config.researcherModel ?? undefined;
    const synthesizerModel = config.synthesizerModel ?? undefined;
    const reviewerModel = config.reviewerModel ?? synthesizerModel;
    // null/undefined both mean "leave the engine default" (old JS contract:
    // positiveInt(..., undefined, ...) omitted the key — keep it omitted).
    const maxTotalAgents = config.maxTotalAgents === undefined || config.maxTotalAgents === null
        ? undefined
        : positiveInt(config.maxTotalAgents, 0, 'maxTotalAgents');
    // Default 1: run researchers one at a time. The round still drains the whole
    // question queue, so serial execution costs nothing but removes the sibling
    // queueing that idle-times out behind a single local engine.
    const maxParallel = config.maxParallel === undefined
        ? 1
        : positiveInt(config.maxParallel, 1, 'maxParallel');
    // Local-friendly run-length knobs. Every one of these trades breadth for wall
    // clock; a local engine turns each researcher into ~7 minutes of serial time,
    // so the question cap is the single biggest lever (15 -> 8 roughly halves the
    // first round).
    const maxQuestions = config.maxQuestions === undefined
        ? 8
        : positiveInt(config.maxQuestions, 8, 'maxQuestions');
    const maxFollowUps = config.maxFollowUps === undefined
        ? 2
        : positiveInt(config.maxFollowUps, 2, 'maxFollowUps');
    const researcherRounds = config.researcherRounds === undefined
        ? 2
        : positiveInt(config.researcherRounds, 2, 'researcherRounds');
    ctx.tools.register(defineTool({
        name: 'deep_research',
        description: 'Deep research orchestrator: an adaptive pipeline built on DSH\'s official workflow engine and '
            + 'designed around control theory and information theory. Call it when a complex topic needs '
            + 'deep research (multi-source information gathering, cross-checking, a written report). '
            + 'The pipeline is alive, not a fixed script: a planner agent fixes the answer space, decomposes '
            + 'the topic into subquestions along information dimensions, and declares its blind-spot '
            + 'assumptions -> the research phase is an adaptive closed loop (the first round studies every '
            + 'subquestion; at the end of each round the high-priority gaps are collected and a follow-up '
            + 'round is dispatched automatically, and the planner\'s blind spots get targeted scouting too) '
            + 'until a round yields zero marginal information gain or the round cap is reached (a simple topic '
            + 'converges in one round, a complex one expands by itself) -> a synthesizer agent compresses '
            + 'everything into the final report by rate-distortion (preserving uncertainty and verified blind '
            + 'spots) -> optional adversarial review (citation correction + coverage audit). '
            + 'Trigger scenarios: deep research, investigation, multi-source synthesis, research reports, '
            + 'literature and material gathering. If the request is vague, clarify scope or intended use with '
            + 'the user first; if you already have a concrete question list, pass it as `questions` to skip '
            + 'the automatic decomposition. '
            + 'Note: by default the return value is the compressed final report only; it does not bundle the '
            + 'raw three-state evidence per subquestion -- that evidence stays in each research subagent\'s '
            + 'session (open that subagent when you need the detail). Pass synthesize:false to get the '
            + 'evidence states directly instead.',
        parameters: {
            topic: {
                type: 'string',
                required: true,
                description: 'The research topic.',
            },
            purpose: {
                type: 'string',
                description: 'Optional: what this research must support (the decision or judgment). Used to define the answer space; when omitted the planner states the use it assumes.',
            },
            questions: {
                type: 'string',
                description: 'Optional: an existing list of research questions (one per line, or numbered 1. 2. 3.). Providing it skips the automatic decomposition.',
            },
            depth: {
                type: 'number',
                description: 'Research thoroughness (tolerance): 1 = preliminary (research loop up to 2 rounds), 2 = deep (default, up to 3), 3 = exhaustive (up to 4).',
            },
            synthesize: {
                type: 'boolean',
                description: 'Whether a synthesizer agent writes the final report (default true). When false, only the three-state evidence per subquestion is returned and you write the report yourself.',
            },
            review: {
                type: 'boolean',
                description: 'Whether a reviewer agent runs an adversarial audit (default false): citation correction, coverage audit, contradictions and overconfidence flagged, plus the highest-priority gaps needing more research.',
            },
            run_in_background: {
                type: 'boolean',
                description: 'Run in the background: return a job id immediately instead of waiting for the research, so your turn is not blocked. '
                    + '**The default depends on who calls it.** When you are a top-level agent talking with a human, the default is true: '
                    + 'the foreground path blocks your turn for the whole run (measured: 3h15m), during which the human cannot talk to you or stop it. '
                    + 'When you are a subagent, the default is false, because you need the report as your own answer. '
                    + 'Pass true to force background, false to force foreground (e.g. to return the report in this same turn). '
                    + 'In the background, read progress with job_output; the result arrives with the completion notice. '
                    + 'A background run does NOT stop when your turn ends.',
            },
        },
        output: {
            schema: {
                // 前景（既定）は研究結果を、背景は job の情報を返す。tool-workflow の
                // 出力スキーマが同じ形（kind で弁別する oneOf）を使っている。
                oneOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', required: true, const: 'foreground' },
                            ok: { type: 'boolean', required: true },
                            report: { type: 'string', required: true },
                            review: { type: 'string' },
                            jobId: { type: 'string' },
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', required: true, const: 'background' },
                            jobId: { type: 'string', required: true },
                        },
                    },
                ],
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.kind === 'background'
                        ? `deep_research をバックグラウンドで開始しました（job ${value.jobId}）。`
                            + '進捗は job_output で読めます。完了通知に結果が付いて届きます。'
                            + '研究者が常駐している間は、直接その研究者へ追加指示を送れます。'
                        : (value.ok
                            ? (value.review !== undefined ? `${value.report}\n\n${value.review}` : value.report)
                            : `deep_research は研究を完了できませんでした：${value.report}`),
                }],
        },
        async execute(args, exec) {
            const parent = exec.agent;
            if (!parent) {
                throw new Error('deep_research requires a calling agent (exec.agent was undefined)');
            }
            // The workflow engine lives behind an `isolate` realm (`isolate:
            // workflowEngine` on the delegation group), so ONLY consumers inside that
            // same realm can see it. Resolve it in this order:
            //   1. this plugin's own ctx — it is mounted inside the delegation group
            //      when the profile patch inserts it there (see README), which is the
            //      placement that actually works on the Web/desktop composition;
            //   2. the calling Agent's scoped ctx — for a host-level mount.
            // `get()` is the non-throwing lookup (a bare `ctx.workflowEngine` accessor
            // throws when the service is not injected).
            const workflowEngine = ctx.get('workflowEngine') ?? parent.ctx.get('workflowEngine');
            if (!workflowEngine) {
                throw new Error('deep_research requires an Agent preset with workflowEngine: mount this plugin inside the preset\'s `delegation` group (or another group sharing its `isolate: workflowEngine` realm), not on the host root');
            }
            // ── 引数の検証を、ジョブを作る前に済ませる ──
            //
            // 順序が大事。ジョブを作ってから throw すると、ジョブの `done` が解決されず
            // 決着しないまま残る（一覧に「実行中」の幽霊が出る）。
            const topic = String(args.topic).trim();
            if (topic.length === 0)
                throw new Error('deep_research: topic must not be empty');
            const purpose = typeof args.purpose === 'string' && args.purpose.trim().length > 0
                ? args.purpose.trim()
                : undefined;
            const depth = args.depth === undefined ? 2 : positiveInt(args.depth, 2, 'depth');
            if (depth > 3) {
                throw new Error('dsh-deep-research: depth must be 1, 2 or 3 (1=初步，2=深入，3=穷尽)');
            }
            const synthesize = args.synthesize !== false;
            const review = args.review === true;
            const parsed = parseQuestionList(args.questions);
            // 呼び出し側の questions にも maxQuestions を適用する。ここを素通しすると
            // 長い指示ブロックを渡された場合に、行数ぶんの研究者が直列で走ってしまう
            // （実測: 逸脱時の各行 ≒ 7 分）。溢れた分は切り詰め、件数は後で planText に出す。
            const questions = parsed.questions.slice(0, maxQuestions);
            const questionsDropped = parsed.questions.length - questions.length + parsed.skipped;
            const models = {};
            if (plannerModel !== undefined)
                models.planner = plannerModel;
            if (researcherModel !== undefined)
                models.researcher = researcherModel;
            if (synthesizerModel !== undefined)
                models.synthesizer = synthesizerModel;
            if (reviewerModel !== undefined)
                models.reviewer = reviewerModel;
            const researchMode = config.researchMode === 'continuable' ? 'continuable' : 'workflow';
            const continuableRetries = config.continuableRetries === undefined
                ? 1
                : Math.max(0, Math.floor(config.continuableRetries));
            const jobs = (parent.ctx.get('jobs') ?? ctx.get('jobs'));
            const label = 'deep_research: ' + topic.slice(0, 60);
            // ── 実行モードの既定を、呼び出し元の立場で決める ──
            //
            // 前景は呼び出し元のターンを塞ぐ。実測で 3 時間 15 分塞がり、その間
            // 人間はエージェントと話せず、中止もできなかった。**人間と対話する立場の
            // エージェント（トップレベル）では、これがそのまま害になる。**
            //
            // 一方サブエージェントは、レポートを自分の答えとして必要とする。背景で
            // 投げると job id だけ受け取ってターンが終わり、成果が届かない。
            //
            // だから既定を立場で分ける。判定はセッションのヘッダで行う（実行時に
            // `Session.header` として読める。サブエージェントは origin:'subagent' と
            // delegationDepth >= 1 を持つ。実測の子セッションで確認済み）。
            const callerHeader = parent.session?.header;
            const callerIsSubagent = callerHeader?.origin === 'subagent'
                || (typeof callerHeader?.delegationDepth === 'number' && callerHeader.delegationDepth > 0);
            const explicitlyBackground = args.run_in_background === true;
            if (explicitlyBackground && jobs === undefined) {
                // 明示された要求は黙って落とさない（呼び出し元は背景を期待している）。
                throw new Error('deep_research: run_in_background requires the `jobs` service');
            }
            // 明示が無ければ、トップレベル（人間と対話する立場）は背景にする。
            // jobs が無い構成では背景が成立しないので前景に落とす（これは能力の欠如で、
            // 呼び出し元の要求違反ではない）。
            const useBackground = explicitlyBackground
                || (!callerIsSubagent && jobs !== undefined && args.run_in_background === undefined);
            /**
             * 研究本体。前景・背景の両方から呼ぶ。
             *
             * `handle` を渡すと進捗がそこへ流れる（無ければ何も出さない）。`signal` は
             * **呼び出し側が組み立てて渡す**: 前景では `exec.signal` と job_kill 用の
             * controller を合成し、背景では controller だけにする。背景で `exec.signal`
             * を混ぜると、ターンが終わった瞬間に研究が殺される（それが前景との違い）。
             *
             * 引数の検証は呼び出し側で済んでいる前提（ここでは throw しない）。
             */
            const runResearch = async (handle, signal) => {
                const progress = handle === undefined ? silentProgress() : jobProgress(handle);
                // ── continuable 経路（実行中に人間が研究者へ注文できる） ──
                // エンジンを使わないので `workflow/*` イベントは来ない。進捗は jobProgress で
                // 直接ジョブへ書く。
                if (researchMode === 'continuable') {
                    const subagents = (parent.ctx.get('subagents') ?? ctx.get('subagents'));
                    const agents = (parent.ctx.get('agents') ?? ctx.get('agents'));
                    if (subagents === undefined || agents === undefined) {
                        throw new Error('deep_research: researchMode "continuable" requires the `subagents` and `agents` services');
                    }
                    progress.log('研究を開始（continuable: 実行中に UI から研究者へ指示できます）');
                    const out = await runContinuableResearch({
                        subagents,
                        agents,
                        parent,
                        signal,
                        provider: subagentProvider ?? 'spawn',
                        progress,
                        retries: continuableRetries,
                    }, {
                        topic,
                        ...(purpose !== undefined ? { purpose } : {}),
                        ...(questions.length > 0 ? { questions } : {}),
                        depth,
                        synthesize,
                        review,
                        maxParallel,
                        maxQuestions,
                        maxFollowUps,
                        researcherRounds,
                        ...(Object.keys(models).length > 0 ? { models } : {}),
                    });
                    return { report: out.report, ...(out.review !== undefined ? { review: out.review } : {}) };
                }
                // ── workflow 経路（既定） ──
                const run = workflowEngine.start({
                    script: SCRIPT,
                    meta: {
                        name: 'deep-research',
                        description: 'Adaptive deep research: answer-space definition, dimension coverage, EIG-driven research rounds, rate-distortion synthesis, optional error-correcting review.',
                        whenToUse: 'Deep research / investigation tasks needing multi-source evidence and a cited report.',
                        phases: [
                            { title: '計画', detail: '答えの空間の定義と、情報次元による網羅的な分解' },
                            { title: '研究', detail: '組み込みの Web ツールを使った適応的な調査ラウンド' },
                            // The engine matches phase() calls by exact title (workflow/types.ts); the
                            // script calls '研究・第Nラウンド' with N up to depth+1 (depth contract: 1-3).
                            { title: '研究・第1ラウンド', detail: '組み込みの Web ツールを使った適応的な調査ラウンド' },
                            { title: '研究・第2ラウンド', detail: '組み込みの Web ツールを使った適応的な調査ラウンド' },
                            { title: '研究・第3ラウンド', detail: '組み込みの Web ツールを使った適応的な調査ラウンド' },
                            { title: '研究・第4ラウンド', detail: '組み込みの Web ツールを使った適応的な調査ラウンド' },
                            { title: '統合', detail: 'レート歪みの考え方による報告の統合' },
                            { title: '審査', detail: '任意で行う誤り訂正のための敵対的審査' },
                        ],
                    },
                    args: {
                        topic,
                        ...(purpose !== undefined ? { purpose } : {}),
                        ...(questions.length > 0 ? { questions } : {}),
                        depth,
                        synthesize,
                        review,
                        maxParallel,
                        maxQuestions,
                        maxFollowUps,
                        researcherRounds,
                        ...(questionsDropped > 0 ? { questionsDropped } : {}),
                        ...(Object.keys(models).length > 0 ? { models } : {}),
                    },
                    ...(subagentProvider !== undefined ? { subagentProvider } : {}),
                    ...(maxTotalAgents !== undefined ? { maxTotalAgents } : {}),
                    parent,
                    signal,
                });
                // run.id は start() の戻りで確定し、phase などのイベントはこの後に来る。
                // ここで対応づければ、自分の実行のイベントだけがジョブに入る。
                if (handle !== undefined) {
                    runJobs.set(String(run.id), handle);
                    handle.updateProgress('研究を開始');
                }
                const result = await run.result;
                if (handle !== undefined)
                    runJobs.delete(String(run.id));
                await run.dispose();
                // `run.result` は reject しない（失敗は stopReason 'error'/'cancelled' として
                // 解決する）ので、ここで初めて失敗が分かる。
                if (result.stopReason !== 'completed') {
                    throw new Error(`deep_research: workflow run ${result.stopReason}${result.error !== undefined ? ` (${result.error})` : ''}`);
                }
                const raw = result.value;
                if (raw === null || typeof raw !== 'object') {
                    throw new Error('deep_research: workflow returned no report');
                }
                const record = raw;
                if (typeof record.report !== 'string') {
                    throw new Error('deep_research: workflow returned no report');
                }
                return {
                    report: record.report,
                    ...(typeof record.review === 'string' ? { review: record.review } : {}),
                };
            };
            // ── 背景実行: 呼び出し元を塞がない ──
            //
            // これが「メインをオーケストレーターにする」ための機構。背景では
            // `exec.signal` を橋渡ししないので、ターンが終わっても研究が生き残る
            // （tool-workflow の startBackgroundRun と同じ扱い。あちらも signal を
            // 渡さないことで、前景との違いを作っている）。呼び出し元は即座に jobId を
            // 受け取り、会話に戻る。中止は job_kill（＝下の controller）。
            if (useBackground) {
                const jobId = jobs.start({
                    kind: 'deep-research',
                    label,
                    owner: String(parent.id),
                    outputLimitBytes: 1 << 20,
                    run: (handle) => {
                        const controller = new AbortController();
                        handle.updateProgress('開始');
                        const done = (async () => {
                            try {
                                await runResearch(handle, controller.signal);
                                handle.updateProgress('完了');
                                return { status: 'completed', result: '研究が完了しました（レポートは job_output で読めます）' };
                            }
                            catch (error) {
                                const message = error instanceof Error ? error.message : String(error);
                                handle.updateProgress('終了: ' + message);
                                return { status: 'failed', detail: message };
                            }
                        })();
                        return {
                            cancel: (reason) => { controller.abort(reason ?? 'deep_research cancelled'); },
                            done,
                        };
                    },
                });
                return { kind: 'background', jobId };
            }
            // ── 前景実行（既定） ──
            const controller = new AbortController();
            let job;
            let settleJob;
            const jobSettled = new Promise((resolve) => { settleJob = resolve; });
            let jobId;
            if (jobs !== undefined && typeof parent.id === 'string' && parent.id.length > 0) {
                try {
                    jobId = jobs.start({
                        kind: 'deep-research',
                        label,
                        owner: String(parent.id),
                        outputLimitBytes: 1 << 20,
                        run: (handle) => {
                            job = handle;
                            handle.updateProgress('開始');
                            return {
                                cancel: (reason) => { controller.abort(reason ?? 'deep_research cancelled'); },
                                done: jobSettled,
                            };
                        },
                    });
                }
                catch (error) {
                    // 観測できないだけで研究は続行する。ただし理由は残す（静かに殺すと
                    // 「なぜ進捗が見えないのか」が分からなくなる）。
                    jobId = undefined;
                    job = undefined;
                    const logger = ctx.logger;
                    logger?.warn?.('deep_research: job mirror unavailable (' + String(error) + '); research continues without progress reporting');
                }
            }
            // ジョブを必ず決着させる（常駐したままのジョブを残さない）。
            const finishJob = (outcome) => {
                if (job === undefined)
                    return;
                job.updateProgress(outcome.status === 'completed'
                    ? '完了'
                    : '終了: ' + String(outcome.detail ?? outcome.status));
                if (settleJob !== undefined)
                    settleJob(outcome);
            };
            // job_kill も exec.signal（呼び出し元のキャンセル）も、同じ研究を止められる
            // ようにする。exec.signal が本物の AbortSignal でない場合は controller 側だけを
            // 使う（AbortSignal.any は AbortSignal 以外を受け取ると TypeError になる）。
            const signal = job === undefined
                ? exec.signal
                : (exec.signal instanceof AbortSignal
                    ? AbortSignal.any([exec.signal, controller.signal])
                    : controller.signal);
            try {
                const out = await runResearch(job, signal);
                finishJob({ status: 'completed', result: '研究が完了しました（詳細はツール結果を参照）' });
                return {
                    kind: 'foreground',
                    ok: true,
                    report: out.report,
                    ...(out.review !== undefined ? { review: out.review } : {}),
                    ...(jobId !== undefined ? { jobId } : {}),
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                finishJob({ status: 'failed', detail: message });
                throw error;
            }
        },
    }));
    if (config.poc === true)
        registerPocTool(ctx);
}
/** 進捗を捨てる実装（ジョブが無い構成）。 */
function silentProgress() {
    return {
        phase: () => void 0,
        childStart: () => void 0,
        childEnd: () => void 0,
        log: () => void 0,
    };
}
/** ジョブへ直接書く進捗。workflow/* を経由しないので、エンジン無しでも見える。 */
function jobProgress(job) {
    return {
        phase: (title) => {
            job.append('== ' + title + ' ==\n');
            job.updateProgress(title);
        },
        // childId を必ず出す。実行中の研究者に人間が指示を送るには対象の特定が要る
        // （UI のサブエージェント一覧でも見えるが、進捗と突き合わせられると確実）。
        childStart: (label, childId) => {
            job.append('  > ' + label + ' 開始  子 ' + childId + '\n');
            job.updateProgress(label);
        },
        childEnd: (label, outcome, childId) => {
            job.append('  v ' + label + ' ' + outcome + '  子 ' + childId + '\n');
        },
        log: (message) => { job.append(message + '\n'); },
    };
}
/**
 * 子に渡す「JSON だけを出せ」という指示。
 *
 * outputSchema が使えないので、スキーマは文章として渡すしかない。曖昧さは
 * 抽出失敗に直結するため、キー名・型・許される値・必須を明示する。
 */
function schemaAsInstructions(schema) {
    const s = schema;
    const props = s?.properties ?? {};
    const required = Array.isArray(s?.required) ? s.required.map(String) : [];
    const describe = (node, depth) => {
        const n = node;
        const t = String(n?.type ?? 'any');
        if (Array.isArray(n?.enum))
            return 'one of: ' + n.enum.map((v) => JSON.stringify(v)).join(' / ');
        if (t === 'array') {
            if (depth > 2)
                return 'array';
            return 'array, each item: ' + describe(n?.items, depth + 1);
        }
        if (t === 'object' && depth <= 2) {
            const sub = Object.entries((n?.properties ?? {}))
                .map(([k, value]) => '      - ' + k + ': ' + describe(value, depth + 1))
                .join('\n');
            return 'object, keys:\n' + sub;
        }
        return t;
    };
    const lines = Object.entries(props).map(([key, node]) => {
        const req = required.includes(key) ? ' (required)' : ' (optional)';
        return '  - ' + key + req + ': ' + describe(node, 1);
    });
    return 'Keys of the JSON object (these and no others -- do not add any):\n' + lines.join('\n');
}
/** 研究者 1 体ぶんのプロンプト（continuable 用。JSON 出力を明示する）。 */
function continuableResearcherPrompt(topic, q, round, limit, isFollowUp) {
    const header = isFollowUp
        ? 'This is follow-up research, round ' + round + ', targeting the high-priority gaps the previous round exposed: '
        : (q.blind
            ? 'This is a targeted scout of a blind-spot hypothesis from planning. Verify whether public information on the following is genuinely scarce (if it truly is, say so in gaps rather than inventing something): '
            : 'Your subquestion: ');
    return 'You are a deep-research subagent. Your job is not to "search as much as possible": the criterion is '
        + 'maximum information gain. Drive the conditional uncertainty about your subquestion down to an acceptable level, then stop immediately.\n\n'
        + 'Research topic: ' + topic + '\n' + header + q.question
        + (q.dimension !== undefined && q.blind !== true ? '\nDimension: ' + q.dimension : '')
        + (q.keywords !== undefined ? '\nSearch keyword leads: ' + q.keywords : '')
        + (q.acceptance !== undefined ? '\nAcceptance criterion (what counts as answered): ' + q.acceptance : '')
        + '\n\nSearch with the built-in web_search tool (fetch specific pages with web_fetch if you have it). Use no tools other than web_search / web_fetch.\n\n'
        + 'Perception-action loop:\n'
        + 'Step 0: write your current best answer, however incomplete.\n'
        + 'Step 1 [Predict]: list the 1-3 highest-entropy uncertainties; pick the query with the highest expected information gain and write: which uncertainty it targets, what new information you expect, and how a contrary result would change your answer.\n'
        + 'Step 2 [Act]: run that query (try both the local language and English).\n'
        + 'Step 3 [Update]: sort the evidence into three states -- confirmed (facts backed by reliable sources) / uncertain (weak or contradictory) / gaps (still missing, tagged with priority).\n'
        + 'Step 4 [Marginal gain]: did this round add confirmed items? Did it overturn or change a conclusion?\n\n'
        + 'Stop criteria (stop when any one holds): last round\'s marginal gain was zero; high-priority gaps cleared; the round limit is reached (at most ' + limit + ' rounds).\n\n'
        + 'Source assessment: authority (prefer government, academic and industry bodies), recency (prefer the last 3 years), reliability. '
        + 'List only sources you actually visited. Prefer not confirming over fabricating -- anything you cannot confirm goes into uncertain or gaps.\n\n'
        + 'IMPORTANT: you may receive additional instructions from the human or from the parent agent at any time. When you do, read them and adjust your direction accordingly.\n\n'
        + 'TWO-WAY COMMUNICATION: if the research direction has an ambiguity that a human must settle (for example: narrow or widen the scope, which of two mutually exclusive readings to take, how to rank priorities), '
        + '**first ask the parent agent with send_message, then continue on the parts the ambiguity does not affect**. '
        + 'Do not idle waiting for an answer, and do not resolve the ambiguity by guesswork and then write it into confirmed as fact -- '
        + 'unresolved points belong in uncertain or gaps. If there is no ambiguity, no question is needed.\n\n'
        + 'OUTPUT FORMAT: when the research is done, output exactly one JSON object. Write no other text, explanation or Markdown code fences:\n'
        + schemaAsInstructions(RESEARCHER_SCHEMA)
        + '\n\nconfidence and priority take only high / medium / low.';
}
/** 計画子のプロンプト（continuable 用）。 */
function continuablePlannerPrompt(topic, purpose, questionCap) {
    return 'You are the planner for a deep research task. The first step of research is to define the question itself: '
        + 'first fix the answer space, then decompose it into subquestions along information dimensions.\n\n'
        + 'Research topic: ' + topic
        + (purpose !== undefined ? '\nIntended use (the decision or judgment this must support): ' + purpose : '')
        + '\n\nWork in this order:\n'
        + '1. [Answer space] Define scope in one sentence.\n'
        + '2. [Information dimensions] Enumerate the information dimensions of the topic space. These become the baseline for the later coverage check.\n'
        + '3. [Diverse decomposition] Map at least one subquestion to each dimension. For each subquestion give its dimension, search keyword leads, and an acceptance criterion.\n'
        + '   **Hard limit on the total number of subquestions: ' + questionCap + '** (the local inference engine studies them one at a time, roughly 7 minutes each). '
        + 'Order them by importance; dimensions beyond the limit go into coverage_gaps.\n'
        + '4. [Coverage assumptions] List coverage_gaps.\n\n'
        + 'OUTPUT FORMAT: output exactly one JSON object. Write no other text and no Markdown code fences:\n'
        + schemaAsInstructions(PLANNER_SCHEMA);
}
/**
 * 子を 1 体作り、完了を待ち、出力を取り出し、**必ず破棄する**。
 *
 * 破棄は `finally` で行う。エラーで抜けても常駐枠を占有したままにしない
 * （枠は 8 しかなく、漏れると以降の研究が起動できなくなる）。
 * `structured` なら JSON を回収して検証する。
 */
async function runContinuableChild(deps, input, structured) {
    const errors = [];
    const attempts = structured ? Math.max(1, deps.retries + 1) : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const label = input.label + (attempt > 1 ? '（再試行' + attempt + '）' : '');
        let childId = '';
        try {
            const started = await deps.subagents.startContinuable({
                provider: deps.provider,
                label,
                request: {
                    prompt: [{ type: 'text', text: input.prompt }],
                    parent: deps.parent,
                    ...(input.model !== undefined ? { agentOptions: { model: input.model } } : {}),
                },
                signal: deps.signal,
            });
            childId = String(started.childId);
            // childId が確定してから進捗に出す（実行中の研究者を特定できるように）。
            deps.progress.childStart(label, childId);
            const child = deps.agents.get(childId);
            if (child === undefined) {
                deps.progress.childEnd(label, 'failed (no agent handle)', childId);
                errors.push('子のハンドルが取得できなかった');
                continue;
            }
            await child.whenIdle();
            const events = child.session.snapshotEvents();
            if (!structured) {
                const text = extractFinalAssistantText(events);
                deps.progress.childEnd(label, text.length > 0 ? 'completed' : 'completed (empty)', childId);
                return { ok: text.length > 0, text, childId, errors };
            }
            const recovered = recoverStructuredOutput(events, input.schema);
            if (recovered.ok) {
                deps.progress.childEnd(label, 'completed', childId);
                return { ok: true, text: recovered.text, value: recovered.value, childId, errors };
            }
            // 検証に落ちた理由は残す。次の試行で同じ失敗を繰り返さないための手掛かり。
            errors.push(...recovered.errors);
            deps.progress.childEnd(label, 'invalid (' + recovered.errors[0] + ')', childId);
            deps.progress.log('  再試行します: ' + recovered.errors.join('; '));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(message);
            deps.progress.childEnd(label, 'error (' + message + ')', childId);
        }
        finally {
            // 常駐枠を必ず返す。失敗した子も残さない。
            if (childId.length > 0) {
                try {
                    await deps.subagents.drainContinuableChildren(deps.parent, [childId]);
                }
                catch (error) {
                    errors.push('解放に失敗: ' + (error instanceof Error ? error.message : String(error)));
                }
            }
        }
    }
    return { ok: false, text: '', childId: '', errors };
}
/**
 * continuable な子だけで研究を回す（workflow エンジンを使わない経路）。
 *
 * 適応ループ（次元の網羅 → 高優先度ギャップによる補充研究 → 自然収束）は
 * SCRIPT と同じ規則を写している。同時実行は既定 1（ローカルエンジンは
 * 1 リクエストずつしか処理しないため、増やしても後ろが待つだけ）。
 */
async function runContinuableResearch(deps, args) {
    const { progress } = deps;
    const M = args.models ?? {};
    const limit = args.depth === 1 ? 1 : (args.researcherRounds || 2);
    const concurrency = Math.max(1, args.maxParallel || 1);
    const followUpCap = Math.max(1, args.maxFollowUps || 2);
    const questionCap = Math.max(1, args.maxQuestions || 8);
    // ── 計画 ──
    progress.phase('計画');
    let subs = args.questions !== undefined && args.questions.length > 0 ? args.questions : null;
    let planText = '';
    if (subs !== null && subs.length > questionCap) {
        planText = '（呼び出し側の子問題 ' + subs.length + ' 件を、ローカル実行のため ' + questionCap + ' 件に絞った）';
        subs = subs.slice(0, questionCap);
    }
    if (subs === null) {
        const planned = await runContinuableChild(deps, {
            goal: 'plan',
            topic: args.topic,
            ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
            prompt: continuablePlannerPrompt(args.topic, args.purpose, questionCap),
            schema: PLANNER_SCHEMA,
            ...(M.planner !== undefined ? { model: M.planner } : {}),
            label: '計画',
        }, true);
        if (!planned.ok || planned.value === undefined) {
            throw new Error('the planner agent returned no usable subquestions' + (planned.errors.length > 0 ? ': ' + planned.errors.join('; ') : ''));
        }
        const plan = planned.value;
        const questions = Array.isArray(plan.questions) ? plan.questions : [];
        if (questions.length === 0)
            throw new Error('the planner agent returned no usable subquestions');
        subs = questions;
        const dims = Array.isArray(plan.dimensions) ? plan.dimensions.map(String) : [];
        const gaps = Array.isArray(plan.coverage_gaps) ? plan.coverage_gaps.map(String) : [];
        planText = '調査の答えの空間：' + (typeof plan.scope === 'string' ? plan.scope : '（未宣言）')
            + '\n覆う次元：' + (dims.length > 0 ? dims.join('、') : '（未宣言）')
            + (gaps.length > 0 ? '\n計画が仮定した盲点（未検証）：' + gaps.join('、') : '');
        // 盲点の偵察も調査キューに入れる（SCRIPT と同じ規則）。
        const room = Math.max(1, questionCap - subs.length);
        subs = subs.concat(gaps.slice(0, room).map((g) => ({ question: g, dimension: '盲点の偵察', blind: true })));
        if (subs.length > questionCap) {
            planText += '\n（ローカル実行のため子問題を ' + questionCap + ' 件に絞った。元 ' + subs.length + ' 件）';
            subs = subs.slice(0, questionCap);
        }
    }
    // ── 研究（適応ループ） ──
    const results = new Map();
    const rounds = [];
    let pending = subs.slice();
    let round = 0;
    while (pending.length > 0 && round < args.depth + 1) {
        round += 1;
        progress.phase('研究・第' + round + 'ラウンド');
        const batch = pending.slice();
        const found = [];
        for (let start = 0; start < batch.length; start += concurrency) {
            const chunk = batch.slice(start, start + concurrency);
            const got = await Promise.all(chunk.map((q, i) => runContinuableChild(deps, {
                goal: 'research',
                topic: args.topic,
                prompt: continuableResearcherPrompt(args.topic, q, round, limit, round > 1),
                schema: RESEARCHER_SCHEMA,
                ...(M.researcher !== undefined ? { model: M.researcher } : {}),
                label: '研究' + (start + i + 1) + '・第' + round + 'ラウンド',
            }, true)));
            for (let i = 0; i < chunk.length; i += 1)
                found[start + i] = got[i].ok ? got[i].value : undefined;
        }
        batch.forEach((q, i) => {
            if (found[i] !== undefined)
                results.set(q.question, found[i]);
        });
        rounds.push(batch.map((q, i) => ({ q, ...(found[i] !== undefined ? { value: found[i] } : {}) })));
        // 収束評価: 高優先度ギャップを次ラウンドの補充研究にする（上限 followUpCap）。
        const leads = [];
        const seen = new Set();
        for (const item of batch) {
            const f = results.get(item.question);
            const gaps = f?.gaps;
            if (!Array.isArray(gaps))
                continue;
            for (const raw of gaps) {
                const g = raw;
                if (g.priority !== 'high' || typeof g.aspect !== 'string')
                    continue;
                if (seen.has(g.aspect) || leads.length >= followUpCap)
                    continue;
                seen.add(g.aspect);
                leads.push({ question: g.aspect });
            }
        }
        pending = leads;
    }
    // ── 証拠の整理 ──
    const ordered = [];
    const seenQ = new Set();
    for (const batch of rounds) {
        for (const item of batch) {
            if (seenQ.has(item.q.question))
                continue;
            seenQ.add(item.q.question);
            ordered.push(item);
        }
    }
    const parts = [];
    let okCount = 0;
    for (const { q, value } of ordered) {
        if (value !== undefined)
            okCount += 1;
        parts.push(value !== undefined
            ? renderFindingsText(q.question, value)
            : '## ' + q.question + '\n\n> この子問題の調査は失敗した（子エージェントが有効な証拠を返さなかった）');
    }
    const totalRounds = rounds.length;
    const intermediate = '# ' + args.topic + ' — 深い調査の中間結果（証拠の状態）\n\n> 子問題 ' + ordered.length
        + ' 件、完了 ' + okCount + ' 件、調査ラウンド ' + totalRounds + ' 回。'
        + (planText ? '\n\n' + planText : '') + '\n\n' + parts.join('\n\n---\n\n');
    // ── 統合 ──
    let report = intermediate;
    if (args.synthesize) {
        progress.phase('統合');
        const final = await runContinuableChild(deps, {
            goal: 'synthesize',
            topic: args.topic,
            ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
            prompt: synthesisPrompt(args.topic, args.purpose, planText, intermediate),
            ...(M.synthesizer !== undefined ? { model: M.synthesizer } : {}),
            label: '統合',
        }, false);
        if (final.ok) {
            report = final.text
                + '\n\n---\n\n> 証拠の状態：子問題 ' + ordered.length + ' 件、完了 ' + okCount + ' 件'
                + (ordered.length > okCount ? '、失敗 ' + (ordered.length - okCount) + ' 件' : '')
                + '、調査ラウンド ' + totalRounds + ' 回。各子問題の三態の証拠（confirmed / uncertain / gaps）は'
                + '対応する研究子エージェントのセッションに残っている。細部が必要なときはその子エージェントの対話を直接開いてほしい（本報告では繰り返さない）。';
        }
    }
    // ── 審査 ──
    let reviewText;
    if (args.review) {
        progress.phase('審査');
        const reviewed = await runContinuableChild(deps, {
            goal: 'review',
            topic: args.topic,
            prompt: reviewPrompt(args.topic, planText, report),
            ...(M.reviewer !== undefined ? { model: M.reviewer } : {}),
            label: '審査',
        }, false);
        if (reviewed.ok)
            reviewText = '## 敵対的審査の意見\n\n' + reviewed.text;
    }
    return {
        report,
        ...(reviewText !== undefined ? { review: reviewText } : {}),
        rounds: totalRounds,
        subquestions: ordered.length,
        completed: okCount,
        failed: ordered.length - okCount,
    };
}
/** 証拠 1 件を Markdown にする（SCRIPT の renderFindings と同じ規則）。 */
function renderFindingsText(question, f) {
    const label = (c) => (c === 'high' ? '高' : c === 'medium' ? '中' : c === 'low' ? '低' : '中');
    const lines = ['## ' + question, ''];
    const confirmed = Array.isArray(f.confirmed) ? f.confirmed : [];
    const uncertain = Array.isArray(f.uncertain) ? f.uncertain : [];
    const gaps = Array.isArray(f.gaps) ? f.gaps : [];
    if (confirmed.length > 0) {
        lines.push('### 確認できた事実（確度）');
        for (const raw of confirmed) {
            const item = raw;
            lines.push('- ' + String(item.claim) + '（確度：' + label(item.confidence) + '、出典：' + String(item.source) + '）');
        }
    }
    if (uncertain.length > 0) {
        lines.push('### 不確実な点');
        for (const raw of uncertain) {
            const item = raw;
            lines.push('- ' + String(item.point) + (item.reason !== undefined ? '（理由：' + String(item.reason) + '）' : ''));
        }
    }
    if (gaps.length > 0) {
        lines.push('### 情報の欠落（優先度）');
        for (const raw of gaps) {
            const item = raw;
            lines.push('- ' + String(item.aspect) + '（優先度：' + label(item.priority) + '）');
        }
    }
    if (confirmed.length === 0)
        lines.push('（この子問題について確認できる証拠は得られなかった）');
    return lines.join('\n');
}
function synthesisPrompt(topic, purpose, planText, intermediate) {
    return 'You are a top-tier industry analyst. Your output is a single lossy compression: under the constraint of report length (rate), keep only the information that discriminates between final conclusions, maximizing decision usefulness (minimizing distortion).\n\n'
        + 'Report topic: ' + topic
        + (purpose !== undefined ? '\nIntended use (the decision or judgment this must support): ' + purpose : '')
        + (planText ? '\n' + planText : '')
        + '\n\nReport structure:\n## Summary (3-5 sentences of core conclusions, including an overall confidence assessment)\n## 1. Background\n## 2. Key findings (organized by dimension; each item carries confidence and a source citation)\n## 3. Uncertainty and contradictions (state plainly which conclusions have low confidence and which sources contradict each other -- uncertainty is itself important information and must be preserved, not masked)\n## 4. Information gaps and verified blind spots (what actually happened to the blind spots planning assumed)\n## 5. Conclusions and recommendations (the best judgment the evidence supports, with the strength of that evidence marked)\n## 6. References'
        + '\n\nRequirements: cite source URLs inline for every key piece of information; distinguish fact (high confidence) from inference (low confidence); present contradictory information side by side; use tables or comparisons where the data suits it; avoid generalities; state plainly where evidence is thin rather than inventing it. Markdown format.\n'
        + '**Length constraint (important):** this is lossy compression, not a compilation. Target 1,500-3,000 characters; 1-3 sentences per point; put in a table what fits in a table; list citations as URLs without restating source content; do not repeat evidence details. Prefer short and decidable over long and diluted.\n\nBelow is what the research found:\n\n' + intermediate;
}
function reviewPrompt(topic, planText, report) {
    return 'You are the reviewer for a research report. Your role is channel error correction: audit the report adversarially and find the noise and errors in its chain of evidence. '
        + 'If web_fetch is in your tool set, spot-check whether suspicious source URLs actually resolve and whether their content supports the citation.\n\n'
        + 'Audit dimensions:\n'
        + '1. Citation errors: does the URL fail to resolve, or is it unrelated to the conclusion? Does the citation actually support the claim? (A hallucinated source is channel noise and must be flagged.)\n'
        + '2. Coverage audit: against the information dimensions planning declared, which dimensions have thin or entirely missing evidence?\n'
        + '3. Contradictions: where sources conflict, is the conflict marked and preserved?\n'
        + '4. Recency: is key data stale?\n'
        + '5. Overconfidence: is any low-confidence conclusion stated as established fact?\n'
        + (planText ? '\nWhat planning declared:\n' + planText : '')
        + '\n\nOutput the review only (Markdown). Do not rewrite the report itself:\n## Review\n### Suspicious sources (if any)\n### Coverage blind spots (if any)\n### Contradictions\n### Overconfident items\n### Highest-priority gaps for further research (if any)\n### Overall assessment and suggested corrections\n\nReport topic: ' + topic + '\n\nReport under review:\n\n' + report;
}
// ── 一時的な検証用（config.poc === true のときだけ登録） ─────────────────────
//
// deep_research を continuable な子で組み直す前に、実機で5点を確かめる:
//   1. startContinuable → whenIdle で「1回の実行の完了」が取れるか
//   2. 子の最終出力が取れるか（イベント名と本文の取り出し方）
//   3. 常駐上限（maxActiveSubagents の既定 8）に当たるか、当たるとどうなるか
//   4. drainContinuableChildren(parent, [childId]) でスロットを解放できるか
//      （実装を読む限り、これが唯一の個別解放経路。activation.releaseSlot() が
//        dispose 経路で呼ばれるため。count=9 + drain=true が上限を超えて通れば証明）
//   5. 返した childId の子に、UI から Steer が届くか（人間が操作して確認）
//
// 検証が終わったらこの節と Config.poc を削除する。
// ── 子の最終出力を取り出す（実測で確定させた契約） ──────────────────────────
//
// `@deepseek-ai/dsh-subagent` の AssistantOutputFold / joinAssistantStreamText の
// 忠実な移植。実装を読んで確定させた形は次のとおりで、素朴に `data.content` を
// 読むと**必ず空になる**（PoC で一度この誤りを書いた）:
//
//   - 確定した本文は `event.data.message.content`（ブロックの配列）
//   - 途中経過は `event.data.stream` に text-chunks / chunk:text-delta として入る
//   - 選択規則: 最後の非空 assistant メッセージ本文。無ければ stream の連結
//
// 選択規則を自前で持つ理由: continuable な子では outputSchema が使えないため
// （ContinuableStartSpec が構造的に除外している）、出力の解釈はこちら側の責任になる。
/** `event.data.stream` の記録から、テキスト断片を連結する。 */
function joinAssistantStream(stream) {
    if (!Array.isArray(stream))
        return '';
    const parts = [];
    for (const raw of stream) {
        const record = raw;
        if (record?.type === 'text-chunks' && Array.isArray(record.texts)) {
            parts.push(record.texts.map(String).join(''));
            continue;
        }
        if (record?.type === 'chunk') {
            const chunk = record.chunk;
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string')
                parts.push(chunk.text);
        }
    }
    return parts.join('');
}
/** 出力ブロックの配列から、text ブロックだけを連結する。 */
function textOfContentBlocks(content) {
    if (!Array.isArray(content))
        return '';
    let text = '';
    for (const raw of content) {
        const block = raw;
        if (block?.type === 'text' && typeof block.text === 'string')
            text += block.text;
    }
    return text;
}
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
export function extractFinalAssistantText(events) {
    let message = '';
    const partial = [];
    for (const raw of events) {
        const event = raw;
        const type = event?.type;
        if (type === 'assistant/message') {
            const data = event.data;
            const text = textOfContentBlocks(data?.message?.content);
            if (text.length > 0)
                message = text;
        }
        if (type === 'assistant/message' || type === 'assistant/attempt') {
            const data = event.data;
            const joined = joinAssistantStream(data?.stream);
            if (joined.length > 0)
                partial.push(joined);
        }
    }
    return message.length > 0 ? message : partial.join('');
}
// ── 構造化出力の回収（`outputSchema` の代替） ────────────────────────────────
//
// continuable な子は `outputSchema` を持てない（ContinuableStartSpec が構造的に
// 除外しており、捕捉ツールを差し込む `setup` / `attachStructuredRuntime` には
// startContinuable から到達できない）。そこで子には「最後に JSON だけを出す」
// よう頼み、こちらで抜き出して検証する。担保は「抽出の頑健さ」と「検証の厳しさ」
// の2点に寄せる: 検証に通らなければ**その子の結果は失敗**として扱い、
// 通ったものだけを下流に流す（黙って壊れた値を混ぜない）。
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
export function extractJsonValue(text) {
    if (typeof text !== 'string' || text.length === 0)
        return undefined;
    const tryParse = (candidate) => {
        try {
            const value = JSON.parse(candidate);
            return { ok: true, value };
        }
        catch {
            return { ok: false };
        }
    };
    // 1) コードフェンス。言語タグは任意。
    const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
    let match;
    while ((match = fence.exec(text)) !== null) {
        const inner = match[1].trim();
        const parsed = tryParse(inner);
        if (parsed.ok)
            return parsed.value;
    }
    // 2) 波括弧の対応を数えて、最初の完全なオブジェクトを切り出す。
    const start = text.indexOf('{');
    if (start >= 0) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i += 1) {
            const ch = text[i];
            if (inString) {
                if (escaped)
                    escaped = false;
                else if (ch === '\\')
                    escaped = true;
                else if (ch === '"')
                    inString = false;
                continue;
            }
            if (ch === '"')
                inString = true;
            else if (ch === '{')
                depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    const parsed = tryParse(text.slice(start, i + 1));
                    if (parsed.ok)
                        return parsed.value;
                    break;
                }
            }
        }
    }
    // 3) 全文。
    const whole = tryParse(text.trim());
    return whole.ok ? whole.value : undefined;
}
/**
 * このプラグインが使う範囲の JSON Schema 検証（object / array / string /
 * number / integer / boolean / enum / required / additionalProperties）。
 *
 * DSH の `assertObjectJsonSchema` は `dsh-tools` の内部で、ここからは参照
 * できないため、必要な部分だけを持つ。**検証は緩めない**方針: 型が違えば
 * 失敗にし、子の出力を勝手に補正しない（補正は誤りを隠す）。
 */
export function checkSchema(schema, value, path = '$') {
    const s = schema;
    if (s === undefined || typeof s !== 'object')
        return [];
    const type = s.type;
    if (typeof type === 'string') {
        const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        if (type === 'integer') {
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                return [path + ' must be integer, got ' + actual];
            }
        }
        else if (type !== actual) {
            return [path + ' must be ' + type + ', got ' + actual];
        }
    }
    if (Array.isArray(s.enum) && !s.enum.includes(value)) {
        return [path + ' must be one of ' + JSON.stringify(s.enum) + ', got ' + JSON.stringify(value)];
    }
    if (Array.isArray(value) && s.items !== undefined) {
        const errors = [];
        value.forEach((item, i) => { errors.push(...checkSchema(s.items, item, path + '[' + i + ']')); });
        return errors;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const record = value;
        const errors = [];
        const props = (s.properties ?? {});
        if (Array.isArray(s.required)) {
            for (const key of s.required) {
                if (typeof key === 'string' && !Object.hasOwn(record, key)) {
                    errors.push(path + '.' + key + ' is required');
                }
            }
        }
        for (const [key, sub] of Object.entries(props)) {
            if (Object.hasOwn(record, key))
                errors.push(...checkSchema(sub, record[key], path + '.' + key));
        }
        if (s.additionalProperties === false) {
            for (const key of Object.keys(record)) {
                if (!Object.hasOwn(props, key))
                    errors.push(path + '.' + key + ' is not allowed');
            }
        }
        return errors;
    }
    return [];
}
/**
 * 子の最終出力から、スキーマに合う JSON オブジェクトを回収する。
 *
 * 子は `outputSchema` を持てないので、ここが唯一の担保になる。抽出に失敗した
 * 場合と検証に落ちた場合を区別して返し、呼び出し側が再試行や失敗扱いを選べる
 * ようにする（黙って部分的に使うことはしない）。
 */
export function recoverStructuredOutput(events, schema) {
    const text = extractFinalAssistantText(events);
    if (text.length === 0)
        return { ok: false, errors: ['子が出力を返さなかった'], text };
    const parsed = extractJsonValue(text);
    if (parsed === undefined) {
        return { ok: false, errors: ['出力から JSON を抽出できなかった'], text };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, errors: ['JSON がオブジェクトではない'], text };
    }
    const errors = checkSchema(schema, parsed);
    if (errors.length > 0)
        return { ok: false, errors, text };
    return { ok: true, value: parsed, text };
}
/** 子のイベント列から、最後の assistant テキストを取り出す試作。 */
function pocLastAssistantText(events) {
    const kinds = [];
    for (const raw of events) {
        const event = raw;
        if (typeof event?.type === 'string')
            kinds.push(event.type);
    }
    return { text: extractFinalAssistantText(events), kinds };
}
function pocDescribe(error) {
    return error instanceof Error ? error.message : String(error);
}
function registerPocTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'poc_continuable',
        description: '検証専用: continuable な子エージェントを count 体作り、完了検出・出力取得・'
            + 'スロット解放を確かめる。drain:true なら各子を完了後に破棄してスロットを解放する'
            + '（実装で確認済みの唯一の解放経路: drainContinuableChildren(parent, [childId])）。'
            + 'count を 9 以上にして drain の有無を比べると、常駐上限 8 の挙動が分かる。'
            + 'hold:true なら完了を待たずに childId だけ返す（UI からの Steer 検証用）。',
        parameters: {
            count: { type: 'number', description: '作る子の数（9 以上でスロット上限を試せる）' },
            prompt: { type: 'string', description: '子に投げるプロンプト' },
            hold: { type: 'boolean', description: 'true なら完了を待たずに childId だけ返す' },
            drain: { type: 'boolean', description: 'true なら各子を完了後に破棄してスロットを解放する' },
            dump: { type: 'boolean', description: 'true なら assistant/* イベントの payload 構造を出力する（診断用）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    log: { type: 'array', required: true, items: { type: 'string' } },
                    childIds: { type: 'array', required: true, items: { type: 'string' } },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.log.join('\n') + '\n\nchildIds:\n' + value.childIds.join('\n'),
                }],
        },
        async execute(args, exec) {
            const parent = exec.agent;
            if (!parent)
                throw new Error('poc_continuable: exec.agent is undefined');
            const runtimeCtx = parent.ctx;
            const subagents = runtimeCtx.get('subagents') ?? ctx.get('subagents');
            const agents = runtimeCtx.get('agents') ?? ctx.get('agents');
            if (!subagents)
                throw new Error('poc_continuable: no `subagents` service');
            if (!agents)
                throw new Error('poc_continuable: no `agents` service');
            const count = Math.max(1, Math.floor(Number(args.count) || 1));
            const text = typeof args.prompt === 'string' && args.prompt.length > 0
                ? args.prompt
                : 'Reply with exactly: POC-OK';
            const drain = args.drain === true;
            const log = [];
            const childIds = [];
            log.push('count=' + count + ' hold=' + String(args.hold === true) + ' drain=' + String(drain));
            for (let i = 0; i < count; i += 1) {
                const at = Date.now();
                let childId;
                try {
                    const started = await subagents.startContinuable({
                        provider: 'spawn',
                        label: 'poc-' + (i + 1),
                        request: { prompt: [{ type: 'text', text }], parent },
                        signal: exec.signal,
                    });
                    childId = String(started.childId);
                    childIds.push(childId);
                    log.push('#' + (i + 1) + ' started ' + childId.slice(0, 8) + ' (+' + (Date.now() - at) + 'ms)');
                }
                catch (error) {
                    // 常駐上限（既定 8）に当たるとここに来る。drain の効果はこの行で判定できる。
                    log.push('#' + (i + 1) + ' START FAILED (+' + (Date.now() - at) + 'ms): ' + pocDescribe(error));
                    break;
                }
                if (args.hold === true)
                    continue;
                const agent = agents.get(childId);
                if (!agent) {
                    log.push('#' + (i + 1) + ' agent handle MISSING for ' + childId.slice(0, 8));
                    continue;
                }
                try {
                    // レース診断: whenIdle の実装は
                    //   do { await (activity = this.activityDone) } while (activity !== this.activityDone)
                    // なので、「呼んだ時点で既に活動が終わっていた」場合は即座に返る。子が
                    // まだ動き出していなければ、output 抽出は空になる。前後のイベント数と
                    // 経過時間を測り、待機が実際に効いたかを判定する。
                    const before = agent.session.snapshotEvents().length;
                    const waitAt = Date.now();
                    await agent.whenIdle();
                    const waited = Date.now() - waitAt;
                    const after = agent.session.snapshotEvents().length;
                    log.push('#' + (i + 1) + ' whenIdle done (+' + (Date.now() - at) + 'ms; waited '
                        + waited + 'ms; events ' + before + ' -> ' + after + ')');
                }
                catch (error) {
                    log.push('#' + (i + 1) + ' whenIdle FAILED: ' + pocDescribe(error));
                    continue;
                }
                try {
                    const events = agent.session.snapshotEvents();
                    const read = pocLastAssistantText(events);
                    // 型は切り詰めない（どれが出ているかが診断の生命線）。
                    log.push('#' + (i + 1) + ' events=' + events.length + ' types=[' + [...new Set(read.kinds)].join(',') + ']');
                    log.push('#' + (i + 1) + ' output(' + read.text.length + ')=' + read.text.slice(0, 70).replace(/\n/g, ' '));
                    if (args.dump === true) {
                        // 診断用: assistant/* の payload 構造をそのまま出す。出力抽出の契約
                        // （data.message.content か data.content か）を実物で確定させるため。
                        for (const raw of events) {
                            const event = raw;
                            const type = String(event?.type ?? '');
                            if (!type.startsWith('assistant/'))
                                continue;
                            const data = event.data;
                            const keys = data === undefined ? '(no data)' : Object.keys(data).join(',');
                            log.push('  DUMP seq=' + String(event.seq) + ' ' + type + ' data.keys=[' + keys + ']');
                            for (const k of ['message', 'content', 'stream']) {
                                const v = data?.[k];
                                if (v === undefined)
                                    continue;
                                const shape = Array.isArray(v)
                                    ? 'array(' + v.length + ')'
                                    : (typeof v === 'object' && v !== null
                                        ? 'object(' + Object.keys(v).join('|') + ')'
                                        : typeof v);
                                log.push('    .' + k + ' = ' + shape);
                            }
                            const preview = JSON.stringify(data).slice(0, 300);
                            log.push('    raw=' + preview);
                        }
                    }
                }
                catch (error) {
                    log.push('#' + (i + 1) + ' output FAILED: ' + pocDescribe(error));
                }
                // スロット解放の唯一の経路（実装で確認）。子を破棄して常駐枠を返す。
                if (drain) {
                    try {
                        await subagents.drainContinuableChildren(parent, [childId]);
                        log.push('#' + (i + 1) + ' drained (+' + (Date.now() - at) + 'ms) -> slot released');
                    }
                    catch (error) {
                        log.push('#' + (i + 1) + ' drain FAILED: ' + pocDescribe(error));
                    }
                }
            }
            log.push('created ' + childIds.length + ' children'
                + (drain ? ' (each drained after use; the slot pool should never fill)'
                    : ' (they stay resident for the UI steer test; over 8 will hit the cap)'));
            return { ok: true, log, childIds };
        },
    }));
}
// ── helpers ─────────────────────────────────────────────────────────────────
/**
 * 呼び出し側が渡した `questions` テキストを行単位で質問に分解する。
 *
 * 実測で見つかった失敗: モデルが「方法制約」や「確定済みの前提」を長いブロックで
 * 渡すと、その**各行が独立した研究質問**になり、1件あたり約7分の直列時間を
 * 無駄にしていた（例:「【方法制約】web_search はAPIキー未設定で必ずエラー…」）。
 * これは質問ではなく指示なので、次の形は捨てる:
 *   - 【…】で始まる行（運営側の指示・前提の宣言）
 *   - 「…せよ / 呼び出すな / 有効」など指示文の語尾で、疑問の形をとらない行
 *   - 極端に長い行（質問ではなく指示の塊とみなす）
 *
 * 捨てた行は黙って消さず、呼び出し元が件数を比較できるよう戻り値に含める。
 */
function parseQuestionList(raw) {
    if (typeof raw !== 'string')
        return { questions: [], skipped: 0 };
    const lines = raw
        .split('\n')
        .map(line => line.replace(/^\s*(?:\d+[.、)])?\s*/, '').trim())
        .filter(line => line.length > 0);
    const questions = [];
    let skipped = 0;
    for (const line of lines) {
        if (looksLikeInstruction(line)) {
            skipped += 1;
            continue;
        }
        questions.push({ question: line });
    }
    return { questions, skipped };
}
/** 質問ではなく運営側の指示・前提の宣言とみなせる行か。 */
function looksLikeInstruction(line) {
    // 【…】や ## で始まる行は節見出し・指示。質問文にはほぼ現れない。
    if (/^[【#]/.test(line))
        return true;
    // 指示の語尾（〜せよ / 〜するな / 〜を使え / 有効 など）で、疑問形でないもの。
    // 文末の句点は付いても付かなくてもよい（実測では「計算せよ。」「が有効。」）。
    const imperative = /(せよ|するな|呼び出すな|呼び出さず|を使え|を使い|に当たれ|が有効|は有効|を疑うな|とすること|含めよ)\s*[。．!！]?\s*$/;
    if (imperative.test(line) && !/[?？]\s*$/.test(line))
        return true;
    // 200 字を超える行は、質問ではなく指示の塊（実測の逸脱は 400 字超だった）。
    if (line.length > 200)
        return true;
    return false;
}
function positiveInt(value, fallback, label) {
    if (value === undefined || value === null)
        return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
        throw new Error(`dsh-deep-research: ${label} must be a positive integer`);
    }
    return n;
}
//# sourceMappingURL=index.js.map