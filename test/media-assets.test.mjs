import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'

test('plugin asset transport preserves media bytes and browser MIME types', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-media-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'review')
  await mkdir(dir)
  await writeFile(join(dir, 'index.html'), '<!doctype html>\n{{REVIEW_BRIDGE}}\n')
  const surface = join(dir, 'surface.json')
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0', id: 'video-craft/visual', title: 'Media',
    project_root: '..', dir: '..', entry: 'review/index.html',
    wake: { mode: 'steer', text: '{unit}' }, capabilities: [],
  }))
  const routes = []
  const context = {
    inject(_names, fn) {
      fn({ connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
        effect(fn) { fn() }, logger: {} })
    },
    effect(fn) { fn() },
    get() { return { register() { return () => {} } } },
    logger: {},
  }
  apply(context, {})
  const route = routes.find(item => item.path === '/api/review.asset')
  assert.ok(route)
  const bytes = new Uint8Array([0, 1, 127, 255])
  for (const [ext, mime] of Object.entries({
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  })) {
    await writeFile(join(root, 'clip.' + ext), bytes)
    const url = new URL('http://dsh.local/api/review.asset')
    url.searchParams.set('surface', surface)
    url.searchParams.set('rel', 'clip.' + ext)
    const response = await route.fetch(new Request(url))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), mime)
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
  }
})
