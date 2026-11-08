/**
 * The model-facing seam: a conversation must be told that a task needing human
 * feedback has a place to go.
 *
 * This is a static prompt section (not a tool description alone), because the
 * decision happens before any tool is chosen. It has to name the tool and the
 * contract's owner without restating the contract — a second copy of the
 * `review-surface` schema in the prompt would drift from
 * `planners-review-core` on the first contract change.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

async function run(t, { withPrompt = true, throwingPrompt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-prompt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'review'), { recursive: true })
  const surface = join(root, 'review', 'surface.json')
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'probe/prompt',
    title: 'Prompt probe',
    project_root: '..',
    dir: '..',
    entry: 'review/index.html',
    wake: { mode: 'queue', text: '{unit}' },
    capabilities: [],
  }))
  const sections = []
  const tools = []
  const disposers = []
  const services = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    sessionController: { prompt: async () => ({ accepted: true }), state: async () => ({ cursor: 0, queue: [] }) },
    agents: { get: () => undefined },
  }
  if (withPrompt || throwingPrompt) {
    services.systemPrompt = {
      section(definition) {
        if (throwingPrompt) throw new Error('prompt assembly refused')
        sections.push(definition)
        return () => { sections.disposed = true }
      },
    }
  }
  const get = (name) => services[name]
  const bridgeCtx = {
    connection: { fetch: { register() { return () => {} } } },
    effect: (run) => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
    logger: {},
    get,
  }
  const ctx = {
    inject(_names, fn) { fn(bridgeCtx) },
    effect: (run) => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
    get,
    logger: {},
  }
  apply(ctx, {})
  return { sections, tools, disposers, surface }
}

test('the model is told when to use the review dock, in one section', async (t) => {
  const { sections, tools } = await run(t)
  assert.equal(sections.length, 1, '只注册一段，别把上下文塞满')
  const section = sections[0]
  assert.equal(section.name, 'tool:review_open')
  assert.equal(typeof section.order, 'number')
  // Section text is interpolated by default, and the text contains a literal
  // `{{REVIEW_BRIDGE}}` marker; without this flag prompt assembly would read it
  // as a variable reference and either drop the marker or fail every request.
  assert.equal(section.interpolate, false)
  assert.match(section.text, /review_open/)
  assert.match(section.text, /planners-review-core/, '契约的权威必须指向 Skill，不能在提示里再抄一份')
  assert.match(section.text, /\{\{REVIEW_BRIDGE\}\}/, '至少要提到注入点，否则页面必然死掉')
  assert.match(section.text, /right sidebar/)
  assert.match(section.text, /not a decision/i, '打开不等于同意，这条必须说出来')
  assert.equal(tools.length, 1, '提示段不是工具；工具仍然只有 review_open')
  assert.equal(tools[0].name, 'review_open')
})

test('the section is disposed with the plugin', async (t) => {
  const { sections, disposers } = await run(t)
  assert.equal(sections.length, 1)
  for (const dispose of disposers) dispose()
  assert.equal(sections.disposed, true)
})

test('a host without the prompt service still installs the tool', async (t) => {
  const { sections, tools } = await run(t, { withPrompt: false })
  assert.equal(sections.length, 0)
  assert.equal(tools.length, 1)
})

test('a prompt registration that throws degrades to a warning, not a broken plugin', async (t) => {
  const { tools } = await run(t, { withPrompt: false, throwingPrompt: true })
  // The throwing service is registered but rejects; the dock must still install.
  assert.equal(tools.length, 1)
})

