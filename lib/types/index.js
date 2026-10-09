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
 * ── 综合 (rate–distortion) ─────────────────────────────────────────────────
 *   The final report is lossy compression for a stated decision: it keeps only
 *   information that distinguishes conclusions, and PRESERVES uncertainty
 *   (confidence / 矛盾 / verified blind spots) instead of masking it.
 *
 * ── 审查 (channel redundancy / error correction, opt-in) ───────────────────
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
    lines.push('### 已确认事实（置信度）')
    for (const item of f.confirmed) {
      lines.push('- ' + item.claim + '（置信度：' + confidenceLabel(item.confidence) + '，来源：' + item.source + '）')
    }
  }
  if (f.uncertain && f.uncertain.length > 0) {
    lines.push('### 不确定项')
    for (const item of f.uncertain) {
      lines.push('- ' + item.point + (item.reason ? '（原因：' + item.reason + '）' : ''))
    }
  }
  if (f.gaps && f.gaps.length > 0) {
    lines.push('### 信息缺口（优先级）')
    for (const item of f.gaps) {
      lines.push('- ' + item.aspect + '（优先级：' + confidenceLabel(item.priority) + '）')
    }
  }
  if (!f.confirmed || f.confirmed.length === 0) lines.push('（该子问题未获得任何可确认的证据）')
  return lines.join('\n')
}

phase('规划')
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
    '你是深度研究规划代理。研究的第一步是定义问题本身：先界定答案空间，再按信息维度拆解子问题。\n\n'
    + '研究主题：' + topic
    + (purpose ? '\n研究用途（要支撑的决策/判断）：' + purpose : '')
    + '\n\n请按以下顺序工作：\n'
    + '1. 【答案空间】用一句话界定 scope：这份研究要回答什么问题、支撑什么判断或决策；若用途未说明，明确写出你假设的用途。\n'
    + '2. 【信息维度】枚举主题空间的信息维度（如：背景与现状、关键技术/机制、主要参与者与生态、数据与规模、趋势与未来、争议与风险、政策与监管、对比分析等，按主题取舍），这是后续覆盖度检查的基准。\n'
    + '3. 【多样性拆解】每个维度至少对应一个子问题（必要多样性定律：子问题集合的多样性必须覆盖主题空间的全部维度，否则必然存在盲区）；每个子问题给出：所属维度、搜索关键词线索（中英文）、验收标准 acceptance（怎样算回答了该子问题）。\n'
    + '   **子问题总数上限：' + questionCap + ' 条**（这是运行环境的硬约束：本地推理引擎逐个研究，每条约 7 分钟）。'
    + '因此请**按重要度排序**，把最能支撑答案空间的维度放在前面；超出上限的维度不要写成子问题，改列入 coverage_gaps。\n'
    + '4. 【覆盖度假设】列出 coverage_gaps：哪些维度你无法用子问题覆盖、或信息可能极难获取。这些会被后续研究轮实际验证——如果侦察发现信息其实可得，会自动补充研究；如果确实不可得，会作为已验证盲区写入报告。\n\n'
    + '只输出 JSON，不要输出任何其他文字。',
    {
      label: '规划',
      phase: '规划',
      schema: PLANNER_SCHEMA,
      ...(M.planner ? { model: M.planner } : {}),
    },
  )
  if (!planned || !Array.isArray(planned.questions) || planned.questions.length === 0) {
    throw new Error('规划子代理未返回有效子问题')
  }
  subs = planned.questions
  const dims = Array.isArray(planned.dimensions) ? planned.dimensions : []
  const gaps = Array.isArray(planned.coverage_gaps) ? planned.coverage_gaps : []
  planText = '研究答案空间：' + (planned.scope || '（未声明）')
    + '\n覆盖维度：' + (dims.length > 0 ? dims.join('、') : '（未声明）')
    + (gaps.length > 0 ? '\n规划假设的盲区（待验证）：' + gaps.join('、') : '')
  // 盲区侦察も子問題として研究キューに入れる。ただし全体を questionCap で抑える:
  // ローカルでは研究者1体 ≒ 7分の直列時間なので、ここが実行時間の最大のレバー。
  // 溢れた分は捨てず、計画の順序（重要度順に作られている想定）を保って切り詰める。
  const room = Math.max(1, questionCap - subs.length)
  subs = subs.concat(gaps.slice(0, room).map((g) => ({ question: g, dimension: '盲区侦察', blind: true })))
  if (subs.length > questionCap) {
    planText += '\n（ローカル実行のため子問題を ' + questionCap + ' 件に絞った。元 ' + (subs.length) + ' 件）'
    subs = subs.slice(0, questionCap)
  }
}

phase('研究')
const researcherPrompt = (q, round, isFollowUp) => {
  const header = isFollowUp
    ? '这是第 ' + round + ' 轮补充研究，针对上一轮暴露的高优先级信息缺口：'
    : (q.blind
      ? '这是对规划阶段"盲区假设"的定向侦察：验证以下方面是否真的缺乏公开信息（若确实没有，明确写进 gaps，不要勉强编造）：'
      : '你的子问题：')
  return '你是深度研究子代理。你的任务不是"尽可能多搜索"，而是以最大信息增益为准则，'
    + '把对该子问题的条件不确定性降到可接受水平，然后立即停止。\n\n'
    + '研究主题：' + topic + '\n' + header + q.question
    + (q.dimension && !q.blind ? '\n所属维度：' + q.dimension : '')
    + (q.keywords ? '\n搜索关键词线索：' + q.keywords : '')
    + (q.acceptance ? '\n验收标准（怎样算回答完成）：' + q.acceptance : '')
    + '\n\n用内置的 web_search 工具搜索（若你的工具集中有 web_fetch，必要时可抓取具体页面；没有则只靠 web_search）。不要使用除 web_search / web_fetch 以外的工具。'
    + '\n\n感知-行动循环（每轮严格按此执行）：\n'
    + '第 0 步：根据已有知识写出你对子问题的当前最佳答案（哪怕不完整）。\n'
    + '第 1 步【预测】：列出当前最不确定的 1-3 个高熵点；为下一个查询选择预期信息增益（EIG）最高的一个，并写一句话：本轮查询针对哪个高熵点、预期新增什么信息、如果得到相反结果会如何改变答案。\n'
    + '第 2 步【行动】：执行该查询（web_search，中英文关键词都试；若你的工具集中有 web_fetch，必要时可抓取关键页面；没有则只靠 web_search）。\n'
    + '第 3 步【更新】：把新证据归入三态：confirmed（有可靠来源支撑的事实）/ uncertain（来源弱或相互矛盾的判断）/ gaps（仍未获得的信息，标注 high/medium/low 优先级）。\n'
    + '第 4 步【边际增益验证】：回答——本轮搜索是否新增了 confirmed 条目？是否改变或推翻了你之前的任何结论？'
    + '\n\n停止准则（信息论意义，满足其一即停，不要再搜）：\n'
    + '- 上一轮边际增益为零：没有新增 confirmed，也没有改变任何结论；\n'
    + '- 高优先级缺口已全部清空；\n'
    + '- 达到轮次硬上限：最多 ' + LIMIT + ' 轮搜索。\n\n'
    + '来源评估：权威性（政府/学术/行业机构优先）、时效性（优先近 3 年）、可靠性（有引用/数据支撑）。'
    + '可信度分级：A 政府/学术/国际组织；B 行业协会/企业白皮书；C 专业媒体；D 个人博客/自媒体。'
    + '只列你实际访问过的来源。宁可不确认，也不要编造——无法确认的点放进 uncertain 或 gaps。\n\n'
    + '输出 JSON（不要输出任何其他文字）：'
    + 'confirmed 数组（每条：claim 结论、source 来源URL、confidence high/medium/low）；'
    + 'uncertain 数组（point 不确定点、reason 原因）；'
    + 'gaps 数组（aspect 缺口方面、priority high/medium/low）。'
}

// ── 自适应研究闭环 ──────────────────────────────────────────────────────────
const results = {}
const rounds = []
let pending = subs.slice()
let round = 0
while (pending.length > 0 && round < depth + 1) {
  round += 1
  phase('研究·第' + round + '轮')
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
      label: '研究' + (start + i + 1) + '·第' + round + '轮',
      phase: '研究·第' + round + '轮',
      schema: RESEARCHER_SCHEMA,
      ...(M.researcher ? { model: M.researcher } : {}),
    })))
    for (let i = 0; i < chunk.length; i += 1) found[start + i] = got[i]
  }
  batch.forEach((q, i) => {
    if (found[i]) results[q.question] = found[i]
  })
  rounds.push(batch.map((q, i) => ({ q, f: found[i] })))

  // 收敛评估：收集本轮所有 high-priority 缺口 → 下一轮动态补充。
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
  // 队列语义：本轮已研究队列中的全部子问题，因此下一轮只剩 high-priority 缺口
  // 作为补充问题；若没有新的 high-priority 缺口，循环自然结束（边际增益为零）。
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
  parts.push(f ? renderFindings(q, f) : '## ' + q.question + '\n\n> 该子问题研究失败（子代理未返回结构化证据）')
}
const totalRounds = rounds.length
const intermediate = '# ' + topic + ' — 深度研究中间结果（证据状态）\n\n> 子问题 ' + ordered.length
  + ' 个，完成 ' + okCount + ' 个，研究轮次 ' + totalRounds + ' 轮。'
  + (planText ? '\n\n' + planText : '') + '\n\n' + parts.join('\n\n---\n\n')

let report = intermediate
if (synthesize) {
  phase('综合')
  const final = await agent(
    '你是顶级行业分析师。你的产出是一次"有损压缩"：在报告长度（率）约束下，只保留对最终结论有区分度的信息，最大化决策有用性（最小化失真）。\n\n'
    + '报告主题：' + topic
    + (purpose ? '\n研究用途（要支撑的决策/判断）：' + purpose : '')
    + (planText ? '\n' + planText : '')
    + '\n\n报告结构：\n## 摘要（3-5 句核心结论，含整体置信度评估）\n## 1. 背景\n## 2. 核心发现（按维度组织，每条附置信度与来源引用）\n## 3. 不确定性与矛盾（明确列出：哪些结论置信度低、哪些来源相互矛盾——不确定性本身就是重要信息，必须保留而非掩盖）\n## 4. 信息缺口与已验证盲区（规划假设的盲区经研究验证后的真实状态）\n## 5. 结论与建议（给出基于现有证据的最优判断，标注证据强度）\n## 6. 参考资料'
    + '\n\n要求：所有关键信息行内引用来源 URL；区分事实（高置信）与推断（低置信）；矛盾信息要并列呈现；用表格/对比呈现适合的数据；避免泛泛而谈；中文输出，Markdown 格式；证据不足处明确说明，不要编造。\n'
    + '**长度约束（重要）**：这是"有损压缩"，不是资料汇编。目标 1,500〜3,000 字；每个论点 1〜3 句；能进表格的不要写成段落；引用只列 URL，不要复述来源内容；不要重复证据细节。宁可短而可判断，不要长而稀释。\n\n以下是研究发现：\n\n' + intermediate,
    {
      label: '综合',
      phase: '综合',
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
      + '\n\n---\n\n> 证据状态：子问题 ' + ordered.length + ' 个，完成 ' + okCount + ' 个'
      + (ordered.length > okCount ? '，失败 ' + (ordered.length - okCount) + ' 个' : '')
      + '；研究轮次 ' + totalRounds + ' 轮。每个子问题的三态证据（confirmed / uncertain / gaps）'
      + '保存在对应研究子代理的会话里，需要细节时可直接查看该子代理的对话，本报告不重复列出。'
  }
}

let reviewText = null
if (review) {
  phase('审查')
  reviewText = await agent(
    '你是研究审阅代理。你的角色是信道纠错：对报告做对抗性审查，找出证据链中的噪声与错误。若你的工具集中有 web_fetch，可用它抽查可疑来源 URL 是否真实可达、内容是否支撑引用；没有则依据 web_search 可得信息评估来源可信度。\n\n'
    + '审查维度：\n'
    + '1. 引用纠错：URL 无法访问或与结论无关？引用是否支撑对应观点？（幻觉来源 = 信道噪声，必须标出）\n'
    + '2. 覆盖度审计：对照规划阶段声明的信息维度，哪些维度证据不足或完全缺失？（Ashby 必要多样性：维度缺失 = 控制器多样性不足 = 盲区）\n'
    + '3. 信息矛盾：不同来源冲突处是否被标注并保留？\n'
    + '4. 时效性：关键数据是否过时？\n'
    + '5. 过度自信：是否有低置信结论被表述为确定事实？\n'
    + (planText ? '\n规划阶段声明：\n' + planText : '')
    + '\n\n只输出审查意见（Markdown，中文），不要改写报告本身：\n## 审查意见\n### 可疑来源（如有）\n### 覆盖盲区（如有）\n### 信息矛盾\n### 过度自信项\n### 需要补充研究的最高优先级缺口（如有，供下一步定向研究）\n### 总体评估与修正建议\n\n报告主题：' + topic + '\n\n以下是待审查报告：\n\n' + report,
    {
      label: '审查',
      phase: '审查',
      ...(M.reviewer ? { model: M.reviewer } : {}),
    },
  )
  if (reviewText) reviewText = '## 对抗性审查意见\n\n' + reviewText
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
        description: '深度研究编排工具（Deep Research Orchestrator，基于 DSH 官方 workflow 引擎，按控制论与'
            + '信息论设计的自适应流程）。当用户要求对复杂主题做深度研究/调研（需要多源信息搜集、'
            + '交叉验证、撰写调研报告）时调用。流程是活的，不是固定脚本：规划子代理先定义答案空间、'
            + '按信息维度拆解子问题并声明盲区假设 → 研究阶段是自适应闭环——第一轮并行研究所有子问题，'
            + '每轮结束收集高优先级信息缺口，自动派发下一轮补充研究（规划盲区也会被定向侦察验证），'
            + '直到某一轮边际信息增益为零或达到轮次上限（简单主题一轮收敛，复杂主题自动扩展）→ '
            + '综合子代理按率失真原则压缩为最终报告（保留不确定性与已验证盲区）→ 可选对抗性审查'
            + '（引用纠错 + 覆盖度审计）。触发场景：深度研究、调研、多源信息综合分析、研究报告、'
            + '文献/资料搜集。若需求模糊，先向用户澄清（用途/范围）再调用；若你已有具体问题清单，'
            + '直接传 questions 可跳过自动拆解。'
            + '注意：默认返回的是**压缩后的最终报告**，不含各子问题的原始三态证据——那些证据留在'
            + '各研究子代理的会话里（需要时打开对应子代理查看）。传 synthesize:false 才会直接返回证据状态。',
        parameters: {
            topic: {
                type: 'string',
                required: true,
                description: '研究主题。',
            },
            purpose: {
                type: 'string',
                description: '可选：研究用途——这份研究要支撑什么判断/决策。用于定义答案空间；缺省时规划子代理会声明假设的用途。',
            },
            questions: {
                type: 'string',
                description: '可选：已有研究问题清单（每行一个，或 1. 2. 3. 编号）。提供后跳过自动拆解阶段。',
            },
            depth: {
                type: 'number',
                description: '研究精度（容差）：1=初步（研究闭环最多2轮），2=深入（默认，最多3轮），3=穷尽（最多4轮）。',
            },
            synthesize: {
                type: 'boolean',
                description: '是否让综合子代理撰写最终报告（默认 true）。false 时只返回各子问题的三态证据，由你撰写。',
            },
            review: {
                type: 'boolean',
                description: '是否让审阅子代理做对抗性审查（默认 false）：引用纠错、覆盖度审计、矛盾与过度自信标注，并给出需要补充研究的最高优先级缺口。',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    report: { type: 'string', required: true },
                    review: { type: 'string' },
                    jobId: { type: 'string' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.ok
                        ? (value.review !== undefined ? `${value.report}\n\n${value.review}` : value.report)
                        : `deep_research 未能完成研究：${value.report}`,
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
            // 観測面: ジョブを 1 つ作り、進捗をそこへ流す。ジョブが無い構成では
            // ミラーせず従来どおり動く（try/catch で握りつぶす）。ジョブは中止の
            // 入口にもなる: job_kill → cancel() → controller.abort → run が cancelled。
            const jobs = (parent.ctx.get('jobs') ?? ctx.get('jobs'));
            const controller = new AbortController();
            let jobId;
            let job;
            let settleJob;
            const jobSettled = new Promise((resolve) => { settleJob = resolve; });
            const topic = String(args.topic).trim();
            if (topic.length === 0)
                throw new Error('deep_research: topic must not be empty');
            // ジョブはトピック確定後に作る（label に使うため）。
            if (jobs !== undefined && typeof parent.id === 'string' && parent.id.length > 0) {
                try {
                    jobId = jobs.start({
                        kind: 'deep-research',
                        label: 'deep_research: ' + topic.slice(0, 60),
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
            // どの経路でもジョブを決着させる（常駐したままのジョブを残さない）。
            const finishJob = (outcome) => {
                if (job === undefined)
                    return;
                job.updateProgress(outcome.status === 'completed'
                    ? '完了'
                    : '終了: ' + String(outcome.detail ?? outcome.status));
                if (settleJob !== undefined)
                    settleJob(outcome);
            };
            // ── continuable 経路（実行中に人間が研究者へ注文できる） ──
            //
            // エンジンを使わないので、`workflow/*` イベントは来ない。進捗は jobProgress で
            // 直接ジョブへ書く。signal は job_kill と exec.signal の両方に反応させる。
            if (researchMode === 'continuable') {
                const subagents = (parent.ctx.get('subagents') ?? ctx.get('subagents'));
                const agents = (parent.ctx.get('agents') ?? ctx.get('agents'));
                if (subagents === undefined || agents === undefined) {
                    finishJob({ status: 'failed', detail: 'no subagents/agents service' });
                    throw new Error('deep_research: researchMode "continuable" requires the `subagents` and `agents` services');
                }
                const progress = job === undefined ? silentProgress() : jobProgress(job);
                progress.log('研究を開始（continuable: 実行中に UI から研究者へ指示できます）');
                try {
                    const out = await runContinuableResearch({
                        subagents,
                        agents,
                        parent,
                        signal: exec.signal instanceof AbortSignal
                            ? AbortSignal.any([exec.signal, controller.signal])
                            : controller.signal,
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
                    finishJob({ status: 'completed', result: '研究が完了しました（詳細はツール結果を参照）' });
                    return {
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
            }
            const run = workflowEngine.start({
                script: SCRIPT,
                meta: {
                    name: 'deep-research',
                    description: 'Adaptive deep research: answer-space definition, dimension coverage, EIG-driven research rounds, rate-distortion synthesis, optional error-correcting review.',
                    whenToUse: 'Deep research / investigation tasks needing multi-source evidence and a cited report.',
                    phases: [
                        { title: '规划', detail: 'Answer-space definition + dimension coverage decomposition' },
                        { title: '研究', detail: 'Adaptive research rounds over built-in web tools' },
                        // The engine matches phase() calls by exact title (workflow/types.ts); the
                        // script calls '研究·第N轮' with N up to depth+1 (depth contract: 1-3).
                        { title: '研究·第1轮', detail: 'Adaptive research round over built-in web tools' },
                        { title: '研究·第2轮', detail: 'Adaptive research round over built-in web tools' },
                        { title: '研究·第3轮', detail: 'Adaptive research round over built-in web tools' },
                        { title: '研究·第4轮', detail: 'Adaptive research round over built-in web tools' },
                        { title: '综合', detail: 'Rate-distortion report synthesis' },
                        { title: '审查', detail: 'Opt-in error-correcting adversarial review' },
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
                // job_kill も exec.signal（親のキャンセル）も、同じ run を止められるようにする。
                // exec.signal が本物の AbortSignal でない場合は controller 側だけを使う
                // （AbortSignal.any は AbortSignal 以外を受け取ると TypeError になる）。
                signal: job === undefined
                    ? exec.signal
                    : (exec.signal instanceof AbortSignal
                        ? AbortSignal.any([exec.signal, controller.signal])
                        : controller.signal),
            });
            // run.id は start() の戻りで確定し、phase などのイベントはこの後に来る。
            // ここで対応づければ、自分の実行のイベントだけがジョブに入る。
            if (job !== undefined) {
                runJobs.set(String(run.id), job);
                job.updateProgress('研究を開始');
            }
            const result = await run.result;
            runJobs.delete(String(run.id));
            await run.dispose();
            // `run.result` は reject しない（失敗は stopReason 'error'/'cancelled' として
            // 解決する）ので、throw しうるのは以下の検証だけ。どの経路でもジョブを
            // 決着させて、常駐したままのジョブを残さない。
            if (result.stopReason !== 'completed') {
                finishJob({ status: 'failed', detail: String(result.stopReason) });
                throw new Error(`deep_research: workflow run ${result.stopReason}${result.error !== undefined ? ` (${result.error})` : ''}`);
            }
            const raw = result.value;
            if (raw === null || typeof raw !== 'object') {
                finishJob({ status: 'failed', detail: 'workflow returned no report' });
                throw new Error('deep_research: workflow returned no report');
            }
            const record = raw;
            if (typeof record.report !== 'string') {
                finishJob({ status: 'failed', detail: 'workflow returned no report' });
                throw new Error('deep_research: workflow returned no report');
            }
            finishJob({ status: 'completed', result: '研究が完了しました（詳細はツール結果を参照）' });
            return {
                ok: true,
                report: record.report,
                ...(typeof record.review === 'string' ? { review: record.review } : {}),
                ...(jobId !== undefined ? { jobId } : {}),
            };
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
    let seq = 0;
    return {
        phase: (title) => {
            job.append('== ' + title + ' ==\n');
            job.updateProgress(title);
        },
        childStart: (label) => {
            seq += 1;
            job.append('  > #' + seq + ' ' + label + ' 開始\n');
            job.updateProgress(label);
        },
        childEnd: (label, outcome) => {
            job.append('  v ' + label + ' ' + outcome + '\n');
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
            return '取值之一: ' + n.enum.map((v) => JSON.stringify(v)).join(' / ');
        if (t === 'array') {
            const inner = t;
            if (depth > 2)
                return '数组';
            return '数组，每项: ' + describe(n?.items, depth + 1);
        }
        if (t === 'object' && depth <= 2) {
            const sub = Object.entries((n?.properties ?? {}))
                .map(([k, value]) => '      - ' + k + ': ' + describe(value, depth + 1))
                .join('\n');
            return '对象，键:\n' + sub;
        }
        return t;
    };
    const lines = Object.entries(props).map(([key, node]) => {
        const req = required.includes(key) ? '（必须）' : '（可选）';
        return '  - ' + key + req + ': ' + describe(node, 1);
    });
    return 'JSON 的键（只允许这些键，不要增加）:\n' + lines.join('\n');
}
/** 研究者 1 体ぶんのプロンプト（continuable 用。JSON 出力を明示する）。 */
function continuableResearcherPrompt(topic, q, round, limit, isFollowUp) {
    const header = isFollowUp
        ? '这是第 ' + round + ' 轮补充研究，针对上一轮暴露的高优先级信息缺口：'
        : (q.blind
            ? '这是对规划阶段"盲区假设"的定向侦察：验证以下方面是否真的缺乏公开信息（若确实没有，明确写进 gaps，不要勉强编造）：'
            : '你的子问题：');
    return '你是深度研究子代理。你的任务不是"尽可能多搜索"，而是以最大信息增益为准则，'
        + '把对该子问题的条件不确定性降到可接受水平，然后立即停止。\n\n'
        + '研究主题：' + topic + '\n' + header + q.question
        + (q.dimension !== undefined && q.blind !== true ? '\n所属维度：' + q.dimension : '')
        + (q.keywords !== undefined ? '\n搜索关键词线索：' + q.keywords : '')
        + (q.acceptance !== undefined ? '\n验收标准（怎样算回答完成）：' + q.acceptance : '')
        + '\n\n用内置的 web_search 工具搜索（若工具集中有 web_fetch，必要时抓取具体页面）。不要使用除 web_search / web_fetch 以外的工具。'
        + '\n\n感知-行动循环：\n'
        + '第 0 步：写出当前最佳答案（哪怕不完整）。\n'
        + '第 1 步【预测】：列出最不确定的 1-3 个高熵点，为下一个查询选预期信息增益最高者，并写明：针对哪个高熵点、预期新增什么、若结果相反会如何改变答案。\n'
        + '第 2 步【行动】：执行该查询（中英文关键词都试）。\n'
        + '第 3 步【更新】：把证据归入三态——confirmed（有可靠来源支撑）/ uncertain（来源弱或矛盾）/ gaps（仍未获得，标注优先级）。\n'
        + '第 4 步【边际增益】：本轮是否新增 confirmed？是否推翻或改变了结论？\n\n'
        + '停止准则（满足其一即停）：上一轮边际增益为零；高优先级缺口清空；达到轮次硬上限（最多 ' + limit + ' 轮）。\n\n'
        + '来源评估：权威性（政府/学术/行业机构优先）、时效性（近3年优先）、可靠性。'
        + '只列你实际访问过的来源。宁可不确认，也不要编造——无法确认的放进 uncertain 或 gaps。\n\n'
        + '【重要】你可以随时收到人类或父代理的追加指示。收到后必须按其调整研究方向。\n\n'
        + '【输出格式】完成研究后，只输出一个 JSON 对象，不要输出任何其他文字、说明或 Markdown 代码块：\n'
        + schemaAsInstructions(RESEARCHER_SCHEMA)
        + '\n\nconfidence 与 priority 只能取 high / medium / low。';
}
/** 計画子のプロンプト（continuable 用）。 */
function continuablePlannerPrompt(topic, purpose, questionCap) {
    return '你是深度研究规划代理。研究的第一步是定义问题本身：先界定答案空间，再按信息维度拆解子问题。\n\n'
        + '研究主题：' + topic
        + (purpose !== undefined ? '\n研究用途（要支撑的决策/判断）：' + purpose : '')
        + '\n\n请按以下顺序工作：\n'
        + '1. 【答案空间】用一句话界定 scope。\n'
        + '2. 【信息维度】枚举主题空间的信息维度，这是后续覆盖度检查的基准。\n'
        + '3. 【多样性拆解】每个维度至少一个子问题；每个子问题给出所属维度、搜索关键词线索、验收标准。\n'
        + '   **子问题总数上限：' + questionCap + ' 条**（本地推理逐条研究，每条约7分钟）。'
        + '按重要度排序，超出上限的维度改列入 coverage_gaps。\n'
        + '4. 【覆盖度假设】列出 coverage_gaps。\n\n'
        + '【输出格式】只输出一个 JSON 对象，不要输出任何其他文字或 Markdown 代码块：\n'
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
        deps.progress.childStart(label);
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
            const child = deps.agents.get(childId);
            if (child === undefined) {
                deps.progress.childEnd(label, 'failed (no agent handle)');
                errors.push('子のハンドルが取得できなかった');
                continue;
            }
            await child.whenIdle();
            const events = child.session.snapshotEvents();
            if (!structured) {
                const text = extractFinalAssistantText(events);
                deps.progress.childEnd(label, text.length > 0 ? 'completed' : 'completed (empty)');
                return { ok: text.length > 0, text, childId, errors };
            }
            const recovered = recoverStructuredOutput(events, input.schema);
            if (recovered.ok) {
                deps.progress.childEnd(label, 'completed');
                return { ok: true, text: recovered.text, value: recovered.value, childId, errors };
            }
            // 検証に落ちた理由は残す。次の試行で同じ失敗を繰り返さないための手掛かり。
            errors.push(...recovered.errors);
            deps.progress.childEnd(label, 'invalid (' + recovered.errors[0] + ')');
            deps.progress.log('  再試行します: ' + recovered.errors.join('; '));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(message);
            deps.progress.childEnd(label, 'error (' + message + ')');
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
    progress.phase('规划');
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
            label: '规划',
        }, true);
        if (!planned.ok || planned.value === undefined) {
            throw new Error('规划子代理未返回有效子问题' + (planned.errors.length > 0 ? ': ' + planned.errors.join('; ') : ''));
        }
        const plan = planned.value;
        const questions = Array.isArray(plan.questions) ? plan.questions : [];
        if (questions.length === 0)
            throw new Error('规划子代理未返回有效子问题');
        subs = questions;
        const dims = Array.isArray(plan.dimensions) ? plan.dimensions.map(String) : [];
        const gaps = Array.isArray(plan.coverage_gaps) ? plan.coverage_gaps.map(String) : [];
        planText = '研究答案空间：' + (typeof plan.scope === 'string' ? plan.scope : '（未声明）')
            + '\n覆盖维度：' + (dims.length > 0 ? dims.join('、') : '（未声明）')
            + (gaps.length > 0 ? '\n规划假设的盲区（待验证）：' + gaps.join('、') : '');
        // 盲区侦察も研究キューに入れる（SCRIPT と同じ規則）。
        const room = Math.max(1, questionCap - subs.length);
        subs = subs.concat(gaps.slice(0, room).map((g) => ({ question: g, dimension: '盲区侦察', blind: true })));
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
        progress.phase('研究·第' + round + '轮');
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
                label: '研究' + (start + i + 1) + '·第' + round + '轮',
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
            : '## ' + q.question + '\n\n> 该子问题研究失败（子代理未返回有效证据）');
    }
    const totalRounds = rounds.length;
    const intermediate = '# ' + args.topic + ' — 深度研究中间结果（证据状态）\n\n> 子问题 ' + ordered.length
        + ' 个，完成 ' + okCount + ' 个，研究轮次 ' + totalRounds + ' 轮。'
        + (planText ? '\n\n' + planText : '') + '\n\n' + parts.join('\n\n---\n\n');
    // ── 統合 ──
    let report = intermediate;
    if (args.synthesize) {
        progress.phase('综合');
        const final = await runContinuableChild(deps, {
            goal: 'synthesize',
            topic: args.topic,
            ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
            prompt: synthesisPrompt(args.topic, args.purpose, planText, intermediate),
            ...(M.synthesizer !== undefined ? { model: M.synthesizer } : {}),
            label: '综合',
        }, false);
        if (final.ok) {
            report = final.text
                + '\n\n---\n\n> 证据状态：子问题 ' + ordered.length + ' 个，完成 ' + okCount + ' 个'
                + (ordered.length > okCount ? '，失败 ' + (ordered.length - okCount) + ' 个' : '')
                + '；研究轮次 ' + totalRounds + ' 轮。每个子问题的三态证据（confirmed / uncertain / gaps）'
                + '保存在对应研究子代理的会话里，需要细节时可直接查看该子代理的对话，本报告不重复列出。';
        }
    }
    // ── 審査 ──
    let reviewText;
    if (args.review) {
        progress.phase('审查');
        const reviewed = await runContinuableChild(deps, {
            goal: 'review',
            topic: args.topic,
            prompt: reviewPrompt(args.topic, planText, report),
            ...(M.reviewer !== undefined ? { model: M.reviewer } : {}),
            label: '审查',
        }, false);
        if (reviewed.ok)
            reviewText = '## 对抗性审查意见\n\n' + reviewed.text;
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
        lines.push('### 已确认事实（置信度）');
        for (const raw of confirmed) {
            const item = raw;
            lines.push('- ' + String(item.claim) + '（置信度：' + label(item.confidence) + '，来源：' + String(item.source) + '）');
        }
    }
    if (uncertain.length > 0) {
        lines.push('### 不确定项');
        for (const raw of uncertain) {
            const item = raw;
            lines.push('- ' + String(item.point) + (item.reason !== undefined ? '（原因：' + String(item.reason) + '）' : ''));
        }
    }
    if (gaps.length > 0) {
        lines.push('### 信息缺口（优先级）');
        for (const raw of gaps) {
            const item = raw;
            lines.push('- ' + String(item.aspect) + '（优先级：' + label(item.priority) + '）');
        }
    }
    if (confirmed.length === 0)
        lines.push('（该子问题未获得任何可确认的证据）');
    return lines.join('\n');
}
function synthesisPrompt(topic, purpose, planText, intermediate) {
    return '你是顶级行业分析师。你的产出是一次"有损压缩"：在报告长度（率）约束下，只保留对最终结论有区分度的信息，最大化决策有用性（最小化失真）。\n\n'
        + '报告主题：' + topic
        + (purpose !== undefined ? '\n研究用途（要支撑的决策/判断）：' + purpose : '')
        + (planText ? '\n' + planText : '')
        + '\n\n报告结构：\n## 摘要（3-5 句核心结论，含整体置信度评估）\n## 1. 背景\n## 2. 核心发现（按维度组织，每条附置信度与来源引用）\n## 3. 不确定性与矛盾（明确列出：哪些结论置信度低、哪些来源相互矛盾——不确定性本身就是重要信息，必须保留而非掩盖）\n## 4. 信息缺口与已验证盲区（规划假设的盲区经研究验证后的真实状态）\n## 5. 结论与建议（给出基于现有证据的最优判断，标注证据强度）\n## 6. 参考资料'
        + '\n\n要求：所有关键信息行内引用来源 URL；区分事实（高置信）与推断（低置信）；矛盾信息要并列呈现；用表格/对比呈现适合的数据；避免泛泛而谈；中文输出，Markdown 格式；证据不足处明确说明，不要编造。\n'
        + '**长度约束（重要）**：这是"有损压缩"，不是资料汇编。目标 1,500〜3,000 字；每个论点 1〜3 句；能进表格的不要写成段落；引用只列 URL，不要复述来源内容；不要重复证据细节。宁可短而可判断，不要长而稀释。\n\n以下是研究发现：\n\n' + intermediate;
}
function reviewPrompt(topic, planText, report) {
    return '你是研究审阅代理。你的角色是信道纠错：对报告做对抗性审查，找出证据链中的噪声与错误。若工具集中有 web_fetch，可抽查可疑来源 URL 是否真实可达、内容是否支撑引用。\n\n'
        + '审查维度：\n'
        + '1. 引用纠错：URL 无法访问或与结论无关？引用是否支撑对应观点？（幻觉来源 = 信道噪声，必须标出）\n'
        + '2. 覆盖度审计：对照规划声明的信息维度，哪些维度证据不足或完全缺失？\n'
        + '3. 信息矛盾：不同来源冲突处是否被标注并保留？\n'
        + '4. 时效性：关键数据是否过时？\n'
        + '5. 过度自信：是否有低置信结论被表述为确定事实？\n'
        + (planText ? '\n规划阶段声明：\n' + planText : '')
        + '\n\n只输出审查意见（Markdown，中文），不要改写报告本身：\n## 审查意见\n### 可疑来源（如有）\n### 覆盖盲区（如有）\n### 信息矛盾\n### 过度自信项\n### 需要补充研究的最高优先级缺口（如有）\n### 总体评估与修正建议\n\n报告主题：' + topic + '\n\n以下是待审查报告：\n\n' + report;
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
                    await agent.whenIdle();
                    log.push('#' + (i + 1) + ' whenIdle done (+' + (Date.now() - at) + 'ms)');
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