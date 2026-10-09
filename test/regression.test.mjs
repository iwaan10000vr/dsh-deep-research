/**
 * dsh-deep-research 回归测试。
 *
 * 运行：cd plugins/dsh-deep-research && node --test
 *（零依赖：不 import src/index.ts 的依赖，纯 node + 内置 node:test/node:vm。
 *  Node ≤20 也可用 node --test test/；Node 22+ 把位置参数当 glob，目录参数
 *  需写成 node --test 'test/**' 或直接用默认发现 node --test。）
 *
 * 机制（镜像引擎）：
 * - 从 src/index.ts 抽取 SCRIPT（String.raw 字面量），按模块加载时的行为插值
 *   ${JSON.stringify(PLANNER_SCHEMA)} / ${JSON.stringify(RESEARCHER_SCHEMA)}；
 * - 用与引擎 runtime.ts 相同的 vm.Script 包装 '(async () => { body })()' 求值，
 *   全局钩子 phase / log / args / agent（按 label 从 mock 队列取值）/
 *   parallel（Promise.all 并发执行 thunk）；
 * - 工具注册层：优先动态 import 真实模块（tsx/DSH 环境，Node ≥22.18 原生类型
 *   剥离直接 import .ts）；纯 node 下依赖不可解析（ERR_MODULE_NOT_FOUND）时
 *   退化为在 vm 中求值模块源码——先经 node:module 的 stripTypeScriptTypes 剥离
 *   类型（原生剥离要求 erasable-only 语法，剥离失败会响亮抛错）。
 *
 * 场景映射：
 *   ① 跳过规划（questions 已给）：单轮研究 → rounds=1，报告含子问题与证据
 *   ② 自适应闭环：high-priority 缺口自动派发第 2 轮补充研究
 *   ③ 规划路径：无 questions 时先规划，盲区假设进入侦察队列
 *   ④ 工具注册：deep_research 注册、输出 schema 在引擎受支持子集内
 *   ⑤ 参数校验：空 topic / depth>3 抛错；questions 解析为数组透传；
 *      models / maxParallel 默认值透传；maxTotalAgents null 不写入请求
 *   ⑥ 队列语义：子问题超过 maxParallel 时跨轮续研，绝不静默丢弃
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const SRC_URL = new URL('../src/index.ts', import.meta.url)
const SRC = readFileSync(SRC_URL, 'utf8')

// ── 脚本抽取：与 src/index.ts 中定义逐字一致的 schema 常量 ────────────────

const PLANNER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string' },
    dimensions: { type: 'array', items: { type: 'string' } },
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
    coverage_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['scope', 'dimensions', 'questions', 'coverage_gaps'],
}

const RESEARCHER_SCHEMA = {
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
}

/** 抽取 String.raw 脚本字面量并复现模块加载时的 ${...} 插值。 */
function extractScript(name) {
  const marker = `const ${name} = String.raw\``
  const start = SRC.indexOf(marker) + marker.length
  if (start < marker.length) throw new Error(`extract failed: ${name} marker not found`)
  const end = SRC.indexOf('`', start)
  if (end < 0) throw new Error(`extract failed: ${name} closing backtick not found`)
  let body = SRC.slice(start, end)
  body = body.replaceAll('${JSON.stringify(PLANNER_SCHEMA)}', JSON.stringify(PLANNER_SCHEMA))
  body = body.replaceAll('${JSON.stringify(RESEARCHER_SCHEMA)}', JSON.stringify(RESEARCHER_SCHEMA))
  if (body.includes('${')) {
    throw new Error(`unexpected interpolation remains in ${name}: ${body.match(/\$\{[^}]*\}/)?.[0] ?? ''}`)
  }
  return body
}

const SCRIPT = extractScript('SCRIPT')

// ── 引擎包装镜像：vm.Script '(async () => { body })()' + 全局钩子 ───────────

const mk = (issues) => ({ confirmed: issues, uncertain: [], gaps: [] })

/**
 * 在 vm 中执行脚本体。roles 按 agent label 提供 mock 队列（null = 子代理失败；
 * 函数 = 以 (prompt, opts) 调用）。队列耗尽或出现未预料的 label 时抛错（响亮失败）。
 * @returns {Promise<{result: any, prompts: Array<{label: string, opts: any}>}>}
 */
async function runScript(body, args, roles = {}) {
  const state = { idx: {}, prompts: [] }
  const take = (key) => {
    const queue = roles[key]
    if (!queue) throw new Error(`unexpected agent call for role "${key}" (no mock provided)`)
    const i = state.idx[key] ?? 0
    if (i >= queue.length) throw new Error(`mock queue exhausted for role "${key}" (${queue.length} entries)`)
    state.idx[key] = i + 1
    return queue[i]
  }
  const context = vm.createContext({})
  context.phase = Object.freeze(() => {})
  context.log = Object.freeze(() => {})
  context.args = args
  context.parallel = Object.freeze((thunks) => Promise.all(thunks.map((t) => t())))
  context.agent = Object.freeze((prompt, opts = {}) => {
    const label = opts.label ?? ''
    state.prompts.push({ label, prompt, opts })
    const role = label.startsWith('研究') ? 'researcher'
      : label === '规划' ? 'planner'
        : label === '综合' ? 'synthesizer'
          : label === '审查' ? 'reviewer'
            : null
    if (!role) throw new Error('unexpected agent label: ' + label)
    // 構造化が必要なのは研究者と計画（三態の証拠 / 計画 JSON を検証するため）。
    // 総合と審査は自由文の Markdown を返すので schema を持たない。
    if ((role === 'researcher' || role === 'planner') && !opts.schema) {
      throw new Error(`${label} 调用缺少 opts.schema（结构化 agent 契约）`)
    }
    const value = take(role)
    return typeof value === 'function' ? value(prompt, opts) : value
  })
  const script = new vm.Script(`(async () => {\n${body}\n})()`, { filename: 'workflow:deep-research-test' })
  const result = await Promise.resolve(script.runInContext(context))
  return { result, prompts: state.prompts }
}

/** vm 求值产生的数组/对象属于 vm realm，deepStrictEqual 会因原型不同误报——JSON 往返转宿主值。 */
const plain = (value) => JSON.parse(JSON.stringify(value))

/**
 * 无损 JSON 判据（镜像引擎 @deepseek-ai/dsh-util-values 的 snapshotJsonValue）：
 * 只要存在显式 undefined / NaN / 函数 / symbol / exotic prototype 等
 * 有损值，就返回 false。JSON 往返（plain()）会静默丢弃这些键，因此
 * 单靠 plain() 断言会漏掉「显式 undefined 属性」这一整类缺陷（issue #9）。
 */
function isLosslessJson(value, seen = new WeakSet()) {
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (t !== 'object') return false // undefined / function / symbol / bigint
  if (seen.has(value)) return false // circular
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) return false // sparse
      if (!isLosslessJson(value[i], seen)) return false
    }
    seen.delete(value)
    return true
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return false // exotic prototype
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  for (const key of Object.keys(value)) {
    if (!isLosslessJson(value[key], seen)) return false
  }
  seen.delete(value)
  return true
}

// ════════════════════════════════════════════════════════════════════════════
// ① 跳过规划（questions 已给）：单轮研究，收敛后返回证据状态报告
// ════════════════════════════════════════════════════════════════════════════
test('① 已给 questions：跳过规划，单轮研究收敛', async () => {
  const { result, prompts } = await runScript(SCRIPT, {
    topic: 'T',
    questions: [{ question: 'Q1', dimension: 'd1' }],
    depth: 1,
    synthesize: false,
    review: false,
    maxParallel: 4,
  }, {
    researcher: [mk([{ claim: 'C1', source: 'https://example.com', confidence: 'high' }])],
  })
  assert.strictEqual(prompts.length, 1, '只应有一次研究调用（无规划/综合/审查）')
  assert.strictEqual(prompts[0].label, '研究1·第1轮')
  assert.strictEqual(prompts[0].opts.phase, '研究·第1轮')
  assert.deepEqual(plain(prompts[0].opts.schema), plain(RESEARCHER_SCHEMA), '研究调用带 RESEARCHER_SCHEMA')
  assert.strictEqual(result.rounds, 1)
  assert.strictEqual(result.subquestions, 1)
  assert.strictEqual(result.completed, 1)
  assert.strictEqual(result.failed, 0)
  assert.strictEqual(result.review, null)
  assert.ok(result.report.includes('## Q1'), '报告应含子问题标题')
  assert.ok(result.report.includes('C1'), '报告应含已确认事实')
  assert.ok(result.report.includes('子问题 1 个，完成 1 个，研究轮次 1 轮'), '报告应含证据状态统计')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑩ 証拠を同梱しない：synthesize:true のレポートは本文＋1行の所在案内だけ
//    実測では生証拠の同梱が親のコンテキストを 12,491 トークン膨らませ、
//    上限の 70% まで押し上げた（400 エラーの瀬戸際）。設計上、成果物は
//    圧縮されたレポートであって証拠の山ではない。
// ════════════════════════════════════════════════════════════════════════════
test('⑩ 証拠を同梱しない：synthesize:true は本文＋所在案内のみ', async () => {
  const longClaim = 'THIS-IS-THE-RAW-EVIDENCE-MARKER'
  const synthText = 'FINAL-REPORT-BODY'

  // (a) synthesize:true → 生証拠は入らない。件数と所在だけが残る。
  {
    const { result } = await runScript(SCRIPT, {
      topic: 'T',
      questions: [{ question: 'Q1', dimension: 'd' }],
      depth: 1,
      synthesize: true,
      review: false,
      maxParallel: 1,
      maxQuestions: 8,
      maxFollowUps: 2,
      researcherRounds: 1,
    }, {
      researcher: [mk([{ claim: longClaim, source: 'https://example.com', confidence: 'high' }])],
      synthesizer: [synthText],
    })
    assert.ok(result.report.includes(synthText), 'レポート本文が入っている')
    assert.ok(!result.report.includes(longClaim), '生証拠（claim 本文）は同梱されない')
    assert.ok(!result.report.includes('## 附录'), '旧「附录：原始证据状态」の節は無くなった')
    assert.ok(result.report.includes('证据状态：子问题 1 个，完成 1 个'), '件数の案内は残る')
    assert.ok(result.report.includes('研究子代理的会话'), '証拠の所在を案内する')
  }

  // (b) synthesize:false → 証拠そのものが成果物なので従来どおり返す。
  {
    const { result } = await runScript(SCRIPT, {
      topic: 'T',
      questions: [{ question: 'Q1', dimension: 'd' }],
      depth: 1,
      synthesize: false,
      review: false,
      maxParallel: 1,
      maxQuestions: 8,
      maxFollowUps: 2,
      researcherRounds: 1,
    }, {
      researcher: [mk([{ claim: longClaim, source: 'https://example.com', confidence: 'high' }])],
    })
    assert.ok(result.report.includes(longClaim), 'synthesize:false では証拠を返す')
    assert.ok(result.report.includes('## Q1'), '証拠状態の節構成')
    assert.ok(!result.report.includes('证据状态：'), 'synthesize:false に所在案内は付けない')
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ② 自适应闭环：high-priority 缺口自动派发下一轮补充研究
// ════════════════════════════════════════════════════════════════════════════
test('② high-priority 缺口自动进入第 2 轮，直到边际增益为零', async () => {
  const { result, prompts } = await runScript(SCRIPT, {
    topic: 'T',
    questions: [{ question: 'Q1', dimension: 'd1' }],
    depth: 2,
    synthesize: false,
    review: false,
    maxParallel: 4,
  }, {
    researcher: [
      { confirmed: [{ claim: 'C1', source: 's1', confidence: 'high' }], uncertain: [], gaps: [{ aspect: 'G1', priority: 'high' }] },
      { confirmed: [{ claim: 'G1 已确认', source: 's2', confidence: 'medium' }], uncertain: [], gaps: [] },
    ],
  })
  assert.strictEqual(result.rounds, 2, '第1轮产出 high 缺口 → 自动第2轮')
  assert.strictEqual(result.subquestions, 2, '两轮子问题都在报告里')
  assert.strictEqual(result.completed, 2)
  assert.ok(result.report.includes('## G1'), '补充研究的问题应入报告')
  assert.ok(result.report.includes('G1 已确认'), '第2轮证据应入报告')
  assert.strictEqual(prompts.length, 2)
  assert.strictEqual(prompts[1].label, '研究1·第2轮', '第2轮是补充研究（follow-up 提示词）')
  assert.ok(prompts[1].prompt.includes('补充研究'), '第2轮提示词应标注补充研究')
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 规划路径：无 questions 时先规划，盲区假设进入侦察队列
// ════════════════════════════════════════════════════════════════════════════
test('③ 无 questions：规划 → 盲区侦察进入第 2 轮', async () => {
  const { result, prompts } = await runScript(SCRIPT, {
    topic: 'T',
    depth: 1,
    synthesize: false,
    review: false,
    maxParallel: 4,
  }, {
    planner: [() => ({
      scope: '支撑决策 D',
      dimensions: ['d1'],
      questions: [{ question: 'Q1', dimension: 'd1' }],
      coverage_gaps: ['盲区X'],
    })],
    researcher: [
      mk([{ claim: 'C1', source: 's1', confidence: 'high' }]),
      mk([{ claim: '盲区X 确实无公开信息', source: '', confidence: 'low' }]),
    ],
  })
  assert.strictEqual(prompts[0].label, '规划', '先规划')
  assert.deepEqual(plain(prompts[0].opts.schema), plain(PLANNER_SCHEMA), '规划调用带 PLANNER_SCHEMA')
  // 盲区侦察与规划问题同轮并行（subs.concat 在循环前），不额外消耗轮次
  assert.strictEqual(result.rounds, 1, '盲区侦察并入第1轮')
  assert.strictEqual(result.subquestions, 2, '规划问题 + 盲区侦察都在报告里')
  assert.ok(result.report.includes('研究答案空间：支撑决策 D'), '报告应含规划答案空间')
  assert.ok(result.report.includes('盲区X'), '盲区侦察结果应入报告')
  const blindPrompt = prompts.find((p) => p.label === '研究2·第1轮')
  assert.ok(blindPrompt && blindPrompt.prompt.includes('盲区假设'), '侦察调用提示词应标注盲区假设')
})

// ════════════════════════════════════════════════════════════════════════════

let pluginPromise = null
function loadPlugin() {
  if (!pluginPromise) {
    pluginPromise = (async () => {
      try {
        const mod = await import(SRC_URL.href)
        return { mod, mode: 'real-import' }
      } catch (err) {
        if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err
        return { mod: evaluateModuleInVm(), mode: 'vm-mock' }
      }
    })()
  }
  return pluginPromise
}

/** 在 vm 中求值模块源码：先剥离类型（原生类型剥离契约），再移除 import/export，注入 mock defineTool。 */
function evaluateModuleInVm() {
  let src = SRC
  src = stripTypeScriptTypes(src) // throws on non-erasable syntax — keeps the source portable
  src = src.replace("import { defineTool } from '@deepseek-ai/dsh-tools'", '')
  src = src.replaceAll(/\bexport\s+/g, '')
  src += '\n;globalThis.__drExports = { name, inject, apply, SCRIPT, PLANNER_SCHEMA, RESEARCHER_SCHEMA, parseQuestionList, looksLikeInstruction }\n'
  const defs = []
  const context = vm.createContext({
    // 镜像 defineTool 的编译契约（dsh-tools schema.ts 子集）：
    // 输出 schema 编译 + 受支持子集断言 + execute 参数校验。
    defineTool: (def) => {
      const parameters = compileParameterSchema(def.parameters)
      const outputSchema = compileOutputSchema(def.output.schema)
      const compiled = {
        ...def,
        parameters,
        output: { ...def.output, schema: outputSchema },
        execute: async (args, exec) => {
          const violations = validateJsonSchemaValue(parameters, args, '')
          if (violations.length > 0) {
            throw new Error('INVALID_ARGS: ' + violations.join('; '))
          }
          return def.execute(args, exec)
        },
      }
      defs.push(compiled)
      return compiled
    },
  })
  new vm.Script(src, { filename: 'dsh-deep-research-lib' }).runInContext(context)
  return { ...context.__drExports, __defs: defs }
}

// ── 移植自 @deepseek-ai/dsh-tools 的 schema 子集（与 dsh-inspect 测试同源）──

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const SCHEMA_ANNOTATIONS = ['description', 'title', 'default', 'examples']

function isSchemaRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compileValueSchema(input, path) {
  if (!isSchemaRecord(input)) throw new Error(`unsupported schema: ${path} must be a value schema object`)
  const node = {}
  switch (input.type) {
    case 'object': {
      node.type = 'object'
      node.additionalProperties = input.additionalProperties
      if (Object.hasOwn(input, 'properties')) {
        const compiled = compilePropertyMap(input.properties, `${path}.properties`)
        node.properties = compiled.properties
        if (compiled.required.length > 0) node.required = compiled.required
      }
      break
    }
    case 'array': {
      node.type = 'array'
      if (Object.hasOwn(input, 'items')) node.items = compileValueSchema(input.items, `${path}.items`)
      break
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      node.type = input.type
      if (Object.hasOwn(input, 'enum')) node.enum = input.enum
      break
    }
    default:
      throw new Error(`unsupported schema: ${path}.type must be within the value schema DSL`)
  }
  return node
}

function compilePropertyMap(input, path) {
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(input)) {
    const p = `${path}.${key}`
    if (!isSchemaRecord(prop)) throw new Error(`unsupported schema: ${p} must be a value schema object`)
    if (Object.hasOwn(prop, 'required')) {
      if (prop.required !== true) throw new Error(`unsupported schema: ${p}.required must be true when present`)
      required.push(key)
    }
    properties[key] = compileValueSchema(prop, p)
  }
  return { properties, required }
}

function compileOutputSchema(spec) {
  const schema = compileValueSchema(spec, 'schema')
  assertSupportedJsonSchema(schema)
  return schema
}

function compileParameterSchema(spec) {
  const compiled = compilePropertyMap(spec, 'parameters')
  const schema = { type: 'object', properties: compiled.properties }
  if (compiled.required.length > 0) schema.required = compiled.required
  assertSupportedJsonSchema(schema)
  return schema
}

function assertSupportedJsonSchema(schema) {
  const violations = []
  checkSchemaNode(schema, 'schema', violations)
  if (violations.length > 0) {
    throw new Error('unsupported JSON schema: ' + violations.join('; '))
  }
}

function checkSchemaNode(node, path, violations) {
  if (!isSchemaRecord(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (['type', 'properties', 'required', 'additionalProperties', 'items', 'enum'].includes(key)) continue
    if (SCHEMA_ANNOTATIONS.includes(key)) continue
    violations.push(`${path}.${key} is not a supported keyword`)
  }
  const type = node.type
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    return
  }
  if (type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      for (const [key, child] of Object.entries(node.properties)) {
        checkSchemaNode(child, `${path}.properties.${key}`, violations)
      }
    }
    if (Object.hasOwn(node, 'required')) {
      const required = node.required
      if (!Array.isArray(required) || required.some((x) => typeof x !== 'string')) {
        violations.push(`${path}.required must be an array of strings`)
      }
    }
  } else if (type === 'array') {
    if (Object.hasOwn(node, 'items')) checkSchemaNode(node.items, `${path}.items`, violations)
  }
}

function validateJsonSchemaValue(schema, value, path = 'value') {
  const violations = []
  checkValue(schema, value, path, violations)
  return violations
}

function checkValue(node, value, path, violations) {
  switch (node.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        violations.push(`"${path}" must be an object`)
        return
      }
      const properties = node.properties ?? {}
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          violations.push(`missing required property "${path}.${key}"`)
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue
        checkValue(child, value[key], `${path}.${key}`, violations)
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`"${path}" must be an array`)
        return
      }
      if (node.items !== undefined) {
        value.forEach((item, i) => checkValue(node.items, item, `${path}[${i}]`, violations))
      }
      break
    }
    default: {
      if (typeof value !== node.type) {
        violations.push(`"${path}" must be a ${node.type}`)
        return
      }
      if (node.enum !== undefined && !node.enum.includes(value)) {
        violations.push(`"${path}" must be one of ${JSON.stringify(node.enum)}`)
      }
    }
  }
}

/**
 * stub ctx + workflowEngine；value 为脚本返回值。
 * 插件不静态 inject 引擎（Web/desktop 组合把引擎 isolate 在 preset 的 delegation
 * 组内，只有同一 isolate 领域内的消费者能看到）。解析顺序是「插件自己的 ctx → 调用方
 * Agent 的 ctx」，所以 stub 必须让其中至少一个的 get('workflowEngine') 可解析。
 *
 * @param value 脚本返回值
 * @param options.engineOnCtx 是否把引擎挂在插件自己的 ctx 上（默认 true）
 * @param options.engineOnAgent 是否把引擎挂在 Agent 的 ctx 上（默认 true）
 */
function stubContext(value, options = {}) {
  const engineOnCtx = options.engineOnCtx ?? true
  const engineOnAgent = options.engineOnAgent ?? true
  const defs = []
  const requests = []
  const workflowEngine = {
    start: (request) => {
      requests.push(request)
      return {
        result: Promise.resolve({ stopReason: 'completed', value }),
        cancel: () => {},
        dispose: async () => {},
        id: 'run-1',
      }
    },
  }
  const ctx = {
    tools: { register: (def) => defs.push(def) },
    ...(engineOnCtx ? { workflowEngine } : {}),
    get: (name) => (name === 'workflowEngine' && engineOnCtx ? workflowEngine : undefined),
  }
  const agentCtx = { get: (name) => (name === 'workflowEngine' && engineOnAgent ? workflowEngine : undefined) }
  return { ctx, agentCtx, defs, requests, workflowEngine }
}

/** 构造调用了插件工具的 exec；引擎按 options 决定挂在谁的作用域上。 */
function stubExec(ctx, signal = new EventTarget()) {
  return { agent: { id: 'parent', ctx }, signal }
}

// ════════════════════════════════════════════════════════════════════════════
// ④ 工具注册：deep_research 注册、输出 schema 在引擎受支持子集内
// ════════════════════════════════════════════════════════════════════════════
test('④ 工具注册与输出 schema 编译通过', async () => {
  const { mod, mode } = await loadPlugin()
  const { ctx, defs } = stubContext({ report: 'r' })
  assert.doesNotThrow(() => mod.apply(ctx, {}), `${mode} 路径下工具注册/编译应通过`)
  assert.strictEqual(defs.length, 1, '应只注册一个工具')
  const def = defs[0]
  assert.strictEqual(def.name, 'deep_research')
  assert.strictEqual(mod.name, 'dsh-deep-research')
  assert.deepEqual(plain(mod.inject), ['tools'], 'inject 只声明 tools（引擎经 Agent 作用域解析）')
  assert.doesNotThrow(() => assertSupportedJsonSchema(def.output.schema), 'output.schema 应在引擎受支持子集内')
  assert.doesNotThrow(() => assertSupportedJsonSchema(def.parameters), 'parameters 应编译为受支持的对象 schema')
  const valid = { ok: true, report: '# r', review: '审阅' }
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, valid), [], '合法输出通过')
  assert.ok(validateJsonSchemaValue(def.output.schema, { ok: true }).length > 0, '缺 report 被拒')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 参数校验与请求透传
// ════════════════════════════════════════════════════════════════════════════
test('⑤ 参数校验：空 topic / depth>3 抛错，不进入 workflowEngine.start', async () => {
  const { mod } = await loadPlugin()
  const { ctx, defs, requests } = stubContext({ report: 'r' })
  mod.apply(ctx, {})
  const def = defs[0]
  const exec = stubExec(ctx)

  await assert.rejects(def.execute({ topic: '   ' }, exec), /topic must not be empty/)
  await assert.rejects(def.execute({ topic: 'T', depth: 4 }, exec), /depth must be 1, 2 or 3/)
  assert.strictEqual(requests.length, 0, '校验失败时不进入 workflowEngine.start')

  // 引擎缺失时（插件自己的 ctx 与 Agent 的 ctx 两侧都看不到 workflowEngine）
  // 应给出明确错误，而不是崩溃。
  const {
    ctx: noEngineCtx,
    defs: noEngineDefs,
    requests: noEngineReqs,
  } = stubContext({ report: 'r' }, { engineOnCtx: false, engineOnAgent: false })
  mod.apply(noEngineCtx, {})
  await assert.rejects(
    noEngineDefs[0].execute({ topic: 'T' }, stubExec(noEngineCtx)),
    /requires an Agent preset with workflowEngine/,
    '两侧都无引擎的 preset 应报明确错误',
  )
  assert.strictEqual(noEngineReqs.length, 0, '无引擎时不应进入 workflowEngine.start')

  const ok = await def.execute({ topic: 'T', depth: 1, questions: '1. Q1\n2. Q2' }, exec)
  assert.strictEqual(ok.ok, true)
  assert.strictEqual(requests.length, 1)
  const req = requests[0]
  assert.strictEqual(req.script, SCRIPT, '透传的脚本与模块中的 SCRIPT 一致')
  assert.strictEqual(req.meta.name, 'deep-research')
  assert.strictEqual(req.parent.id, 'parent', 'parent 透传给引擎')
  assert.strictEqual(req.signal, exec.signal, 'signal 透传给引擎')
  assert.deepEqual(plain(req.args.questions), [
    { question: 'Q1' },
    { question: 'Q2' },
  ], 'questions 解析为数组透传')
  // issue #9：显式 undefined 属性是有损 JSON，会让真实引擎的 begin 绑定抛
  // "workflow binding value must be lossless JSON"。plain() 会把它洗掉，故此处
  // 用严格判据直接检查透传的 args。
  assert.ok(isLosslessJson(req.args), 'args 必须是无损 JSON（不得含显式 undefined 属性）')
  for (const q of req.args.questions) {
    assert.deepEqual(Object.keys(q), ['question'], 'questions 项不得携带显式 undefined 的 keywords 键')
  }
  assert.strictEqual(req.args.depth, 1)
  assert.strictEqual(req.args.synthesize, true, 'synthesize 默认 true')
  assert.strictEqual(req.args.review, false, 'review 默认 false')
  assert.strictEqual(req.args.maxParallel, 1, 'maxParallel 默认 1（本地引擎串行）')
  assert.strictEqual(req.args.maxQuestions, 8, 'maxQuestions 默认 8（ローカルの実行時間レバー）')
  assert.strictEqual(req.args.maxFollowUps, 2, 'maxFollowUps 默认 2（収束しやすくする）')
  assert.strictEqual(req.args.researcherRounds, 2, 'researcherRounds 默认 2')
  assert.ok(!('models' in req.args), '未配置 models 时不传 models 键')
  assert.ok(!('subagentProvider' in req), '未配置时不传 subagentProvider')

  // 配置透传：models / maxParallel / subagentProvider / 長さノブ
  const { ctx: ctx2, defs: defs2, requests: requests2 } = stubContext({ report: 'r' })
  mod.apply(ctx2, {
    plannerModel: 'pm',
    researcherModel: 'rm',
    maxParallel: 2,
    subagentProvider: 'fork',
    maxTotalAgents: 7,
    maxQuestions: 3,
    maxFollowUps: 1,
    researcherRounds: 4,
  })
  await defs2[0].execute({ topic: 'T', depth: 2 }, stubExec(ctx2))
  const req2 = requests2[0]
  assert.deepEqual(plain(req2.args.models), { planner: 'pm', researcher: 'rm' }, '角色模型透传')
  assert.strictEqual(req2.args.maxParallel, 2)
  assert.strictEqual(req2.args.maxQuestions, 3, 'maxQuestions 透传')
  assert.strictEqual(req2.args.maxFollowUps, 1, 'maxFollowUps 透传')
  assert.strictEqual(req2.args.researcherRounds, 4, 'researcherRounds 透传')
  assert.strictEqual(req2.subagentProvider, 'fork')
  assert.strictEqual(req2.maxTotalAgents, 7)

  // maxTotalAgents 为 null/undefined 时请求省略该键（引擎用默认上限），
  // 绝不写入 0（引擎对 <1 的 maxTotalAgents 直接 INVALID_ARGUMENT）。
  const { ctx: nullCtx, defs: nullDefs, requests: nullReqs } = stubContext({ report: 'r' })
  mod.apply(nullCtx, { maxTotalAgents: null })
  await nullDefs[0].execute({ topic: 'T' }, stubExec(nullCtx))
  assert.strictEqual(nullReqs.length, 1)
  assert.ok(!('maxTotalAgents' in nullReqs[0]), 'maxTotalAgents: null 不写入请求（引擎默认）')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑥ 队列语义：单轮消化全部子问题，绝不静默丢弃
// ════════════════════════════════════════════════════════════════════════════
test('⑥ 全队列在单轮内消化：maxParallel 只限并发，不再把问题拆到后续轮次', async () => {
  const questions = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'].map((q) => ({ question: q, dimension: 'd' }))
  const { result, prompts } = await runScript(SCRIPT, {
    topic: 'T',
    questions,
    depth: 2,
    synthesize: false,
    review: false,
    maxParallel: 2,
  }, {
    researcher: [
      { confirmed: [{ claim: 'C1', source: 's1', confidence: 'high' }], uncertain: [], gaps: [] },
      { confirmed: [{ claim: 'C2', source: 's2', confidence: 'high' }], uncertain: [], gaps: [] },
      { confirmed: [{ claim: 'C3', source: 's3', confidence: 'high' }], uncertain: [], gaps: [] },
      { confirmed: [{ claim: 'C4', source: 's4', confidence: 'high' }], uncertain: [], gaps: [] },
      { confirmed: [{ claim: 'C5', source: 's5', confidence: 'high' }], uncertain: [], gaps: [] },
      { confirmed: [{ claim: 'C6', source: 's6', confidence: 'high' }], uncertain: [], gaps: [] },
    ],
  })
  assert.strictEqual(result.rounds, 1, '一轮消化全部 6 个子问题（轮次上限留给补充研究，不用于余留队列）')
  assert.strictEqual(result.subquestions, 6, '所有子问题都被研究（无静默丢弃）')
  assert.strictEqual(result.completed, 6)
  for (const q of questions) {
    assert.ok(result.report.includes('## ' + q.question), `报告应含 ${q.question}`)
  }
  assert.strictEqual(prompts.length, 6)
  assert.deepEqual(prompts.map((p) => p.label), [
    '研究1·第1轮', '研究2·第1轮', '研究3·第1轮',
    '研究4·第1轮', '研究5·第1轮', '研究6·第1轮',
  ], '同一轮内按序编号，轮次不递增')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑦ 并发上限：同时运行的 researcher 绝不超过 maxParallel（本地引擎串行的核心保证）
// ════════════════════════════════════════════════════════════════════════════
test('⑦ 并发上限：同时运行的 researcher 不超过 maxParallel（1=严格串行）', async () => {
  const questions = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'].map((q) => ({ question: q, dimension: 'd' }))

  const probe = async (maxParallel) => {
    let inFlight = 0
    let peak = 0
    const one = () => async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return mk([{ claim: 'C', source: 's', confidence: 'high' }])
    }
    const { result } = await runScript(SCRIPT, {
      topic: 'T',
      questions,
      depth: 1,
      synthesize: false,
      review: false,
      maxParallel,
    }, {
      researcher: questions.map(one),
    })
    assert.strictEqual(result.completed, questions.length, '全部子问题仍被研究')
    return peak
  }

  assert.strictEqual(await probe(1), 1, 'maxParallel=1 时严格串行（无重叠）')
  assert.strictEqual(await probe(2), 2, 'maxParallel=2 时同时最多 2 个')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑧ 引擎解析顺序：插件自身的 ctx 优先于调用方 Agent 的 ctx
//    （Web/desktop 把 workflowEngine isolate 在 preset 的 delegation 组内，
//      插件必须挂在那组里才能看见；宿主级挂载则回退到 Agent 作用域）
// ════════════════════════════════════════════════════════════════════════════
test('⑧ 引擎解析：插件自身 ctx 优先，Agent 作用域作为回退', async () => {
  const { mod } = await loadPlugin()

  // (a) 只有插件自身 ctx 能看到引擎（= 挂在 delegation 组内）：必须可用。
  {
    const { ctx, defs, requests } = stubContext({ report: 'r' }, { engineOnCtx: true, engineOnAgent: false })
    mod.apply(ctx, {})
    const ok = await defs[0].execute({ topic: 'T', depth: 1, questions: '1. Q1' }, stubExec({ get: () => undefined }))
    assert.strictEqual(ok.ok, true, '插件自身 ctx 有引擎时应正常启动 workflow')
    assert.strictEqual(requests.length, 1)
  }

  // (b) 只有 Agent 的 ctx 能看到引擎（= 宿主级挂载的旧路径）：仍然可用。
  {
    const { ctx, agentCtx, defs, requests } = stubContext({ report: 'r' }, { engineOnCtx: false, engineOnAgent: true })
    mod.apply(ctx, {})
    const ok = await defs[0].execute({ topic: 'T', depth: 1, questions: '1. Q1' }, stubExec(agentCtx))
    assert.strictEqual(ok.ok, true, 'Agent 作用域有引擎时应正常启动 workflow')
    assert.strictEqual(requests.length, 1)
  }

  // (c) 两侧都没有：明确报错，且提示正确的挂载位置。
  {
    const { ctx, defs } = stubContext({ report: 'r' }, { engineOnCtx: false, engineOnAgent: false })
    mod.apply(ctx, {})
    await assert.rejects(
      defs[0].execute({ topic: 'T' }, stubExec(ctx)),
      /mount this plugin inside the preset's `delegation` group/,
      '错误信息应指向 delegation 组这个正确挂载点',
    )
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ⑨ 長さノブ：ローカルで「短く終わる」ための上限が実際に効く
//    実測の根拠: 質問 15 件で第1ラウンドだけで 105 分、補充 4 件 ×3 ラウンドで
//    さらに 57 分。ここを絞ることが実行時間の最大のレバー。
// ════════════════════════════════════════════════════════════════════════════
test('⑨ 長さノブ：質問数・補充研究・研究者ラウンドの上限が効く', async () => {
  const mkRes = (n, gaps) => ({
    confirmed: [{ claim: 'C' + n, source: 's' + n, confidence: 'high' }],
    uncertain: [],
    gaps: (gaps ?? []).map((g) => ({ aspect: g, priority: 'high' })),
  })

  // (a) 計画が出した 12 問 + 盲区 6 件は、maxQuestions で切り詰められる。
  {
    const plannedQuestions = Array.from({ length: 12 }, (_, i) => ({ question: 'Q' + (i + 1), dimension: 'd' + i }))
    const researcher = Array.from({ length: 20 }, (_, i) => mkRes(i + 1, []))
    const { result, prompts } = await runScript(SCRIPT, {
      topic: 'T',
      depth: 1,
      synthesize: false,
      review: false,
      maxParallel: 1,
      maxQuestions: 8,
      maxFollowUps: 2,
      researcherRounds: 1,
    }, {
      planner: [() => ({
        scope: 'S',
        dimensions: ['d1'],
        questions: plannedQuestions,
        coverage_gaps: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'],
      })],
      researcher,
    })
    assert.strictEqual(prompts[0].label, '规划', '先に計画')
    assert.strictEqual(
      prompts.length - 1,
      8,
      '研究者は maxQuestions=8 体だけ（計画 12 + 盲区 6 を切り詰め）',
    )
    assert.strictEqual(result.subquestions, 8, '報告の子問題も 8 件')
    assert.ok(result.report.includes('絞った'), '切り詰めたことを planText に明示する')
  }

  // (b) maxFollowUps が補充研究の件数を抑える。同じ研究者（毎回 3 件の high
  //     ギャップを返す）でも、cap の値で総研究者数が変わることを比較で示す。
  //     depth=2 は 3 ラウンド上限なので、1 + cap + cap が期待値になる。
  {
    const run = async (maxFollowUps) => {
      const researcher = []
      for (let i = 0; i < 40; i += 1) researcher.push(mkRes(i + 1, ['G' + i + 'a', 'G' + i + 'b', 'G' + i + 'c']))
      const { result, prompts } = await runScript(SCRIPT, {
        topic: 'T',
        questions: [{ question: 'Q1', dimension: 'd' }],
        depth: 2, // ラウンド上限 3
        synthesize: false,
        review: false,
        maxParallel: 1,
        maxQuestions: 8,
        maxFollowUps,
        researcherRounds: 1,
      }, { researcher })
      assert.strictEqual(result.rounds, 3, 'ラウンド上限 3 まで走る')
      return prompts.length
    }
    assert.strictEqual(await run(1), 3, 'cap=1 → 1+1+1 = 3 体')
    assert.strictEqual(await run(2), 5, 'cap=2 → 1+2+2 = 5 体')
    // cap=4 は第1ラウンドのギャップが 3 件しか無いので 1→3、第2ラウンドで
    // 9 件出て初めて cap に達する: 1+3+4 = 8 体。cap は補充の「増殖」を
    // 抑えるが、抑えきれないと上限まで走る（だから既定は 2 にしてある）。
    assert.strictEqual(await run(4), 8, 'cap=4 → 1+3+4 = 8 体')
  }

  // (b2) 補充が尽きれば上限に達する前に自然収束する。
  {
    const { result, prompts } = await runScript(SCRIPT, {
      topic: 'T',
      questions: [{ question: 'Q1', dimension: 'd' }],
      depth: 3, // 4 ラウンドまで許す
      synthesize: false,
      review: false,
      maxParallel: 1,
      maxQuestions: 8,
      maxFollowUps: 2,
      researcherRounds: 1,
    }, {
      researcher: [
        mkRes(1, ['A1', 'A2', 'A3']), // → 補充 2 件
        mkRes(2, []),                 // ギャップなし
        mkRes(3, []),                 // ギャップなし
      ],
    })
    assert.strictEqual(result.rounds, 2, 'ギャップが尽きたら 4 ラウンド目を待たず収束する')
    assert.strictEqual(prompts.length, 3, '1 + 2 = 3 体で終わる')
  }

  // (c) depth=1 なら研究者の内部探索ラウンドは 1（LIMIT）になる。
  {
    const { prompts } = await runScript(SCRIPT, {
      topic: 'T',
      questions: [{ question: 'Q1', dimension: 'd' }],
      depth: 1,
      synthesize: false,
      review: false,
      maxParallel: 1,
      maxQuestions: 8,
      maxFollowUps: 2,
      researcherRounds: 2,
    }, {
      researcher: [mkRes(1, [])],
    })
    assert.ok(
      prompts[0].prompt.includes('最多 1 轮搜索'),
      'depth=1 は研究者の探索を 1 ラウンドに制限する（prompt に反映）',
    )
  }

  // (d) researcherRounds が depth>1 のとき研究者プロンプトに反映される。
  {
    const { prompts } = await runScript(SCRIPT, {
      topic: 'T',
      questions: [{ question: 'Q1', dimension: 'd' }],
      depth: 2,
      synthesize: false,
      review: false,
      maxParallel: 1,
      maxQuestions: 8,
      maxFollowUps: 2,
      researcherRounds: 3,
    }, {
      researcher: [mkRes(1, [])],
    })
    assert.ok(
      prompts[0].prompt.includes('最多 3 轮搜索'),
      'researcherRounds=3 が研究者プロンプトに反映される',
    )
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ⑪ 呼び出し側 questions の衛生：指示文を質問にしない・上限を掛ける
//    実測の逸脱: モデルが「方法制約」等の長いブロックを questions に渡し、
//    その各行が研究質問になった（「【方法制約】web_search はAPIキー未設定で…」）。
//    1 行 ≒ 7 分の直列時間なので、無駄が大きい。
// ════════════════════════════════════════════════════════════════════════════
test('⑪ 呼び出し側 questions：指示文を除外し、上限を掛ける', async () => {
  const { mod } = await loadPlugin()

  // 実測で観測した逸脱をそのまま再現する。指示文と質問が混ざったブロックを
  // 渡したとき、研究者になるのは質問だけであるべき。
  const blob = [
    '【方法制約】web_search はAPIキー未設定で必ずエラーになる。呼び出さず、検索は web_fetch を使え。',
    '【確定済みの圏内判定（これを疑うな）】碧南市 約6.6km圏内、高浜市街地 約9.36km圏内。',
    '岡崎空襲（昭和20年7月19〜20日）の被害規模と軍事的理由は何か。',
    '八丁味噌の醸造2社の明治〜昭和の産業史は何か。',
    '距離は中心点からhaversineで計算せよ。',
    'ja.wikipedia.org、各市公式サイトが有効。',
  ].join('\n')

  // (a) 指示文は研究対象にならない。質問 2 件だけが研究者に渡る。
  {
    const { ctx, defs, requests } = stubContext({ report: 'r' })
    mod.apply(ctx, {})
    await defs[0].execute({ topic: 'T', depth: 1, questions: blob }, stubExec(ctx))
    const qs = requests[0].args.questions
    assert.deepEqual(
      plain(qs.map((q) => q.question)),
      [
        '岡崎空襲（昭和20年7月19〜20日）の被害規模と軍事的理由は何か。',
        '八丁味噌の醸造2社の明治〜昭和の産業史は何か。',
      ],
      '指示文 4 行を除いた質問 2 件だけが研究対象になる',
    )
    assert.strictEqual(requests[0].args.questionsDropped, 4, '除外した行数をスクリプトに伝える')
  }

  // (b) 呼び出し側の questions にも上限が掛かる（旧実装は素通しだった）。
  {
    const many = Array.from({ length: 12 }, (_, i) => `質問${i + 1}は何か。`).join('\n')
    const { ctx, defs, requests } = stubContext({ report: 'r' })
    mod.apply(ctx, { maxQuestions: 3 })
    await defs[0].execute({ topic: 'T', depth: 1, questions: many }, stubExec(ctx))
    assert.strictEqual(requests[0].args.questions.length, 3, '呼び出し側の 12 件が 3 件に切られる')
    assert.strictEqual(requests[0].args.questionsDropped, 9, '切った件数も伝える')
  }

  // (c) 逸脱が無ければ questionsDropped を書かない（無損 JSON を保つ）。
  {
    const { ctx, defs, requests } = stubContext({ report: 'r' })
    mod.apply(ctx, { maxQuestions: 8 })
    await defs[0].execute({ topic: 'T', depth: 1, questions: '1. Q1\n2. Q2' }, stubExec(ctx))
    assert.ok(!('questionsDropped' in requests[0].args), '0 件のときは questionsDropped を書かない')
    assert.strictEqual(requests[0].args.questions.length, 2, '普通の質問はそのまま通る')
  }

  // (d) スクリプト側でも、呼び出し側の質問に対する切り詰めを明示する。
  {
    const many = Array.from({ length: 6 }, (_, i) => ({ question: 'Q' + (i + 1), dimension: 'd' }))
    const { result } = await runScript(SCRIPT, {
      topic: 'T',
      questions: many,
      depth: 1,
      synthesize: false,
      review: false,
      maxParallel: 1,
      maxQuestions: 2,
      maxFollowUps: 2,
      researcherRounds: 1,
    }, {
      researcher: [
        mk([{ claim: 'C1', source: 's1', confidence: 'high' }]),
        mk([{ claim: 'C2', source: 's2', confidence: 'high' }]),
      ],
    })
    assert.strictEqual(result.subquestions, 2, '研究されたのは 2 件だけ')
    assert.ok(result.report.includes('絞った'), '切り詰めたことを planText に明示する')
  }
})
