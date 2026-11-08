/**
 * The upload bound is only real if it is enforced BEFORE the bytes are held.
 *
 * The route used to be `requestBody: 'buffered'` and read the whole body with
 * `arrayBuffer()` before comparing it to 16 MiB — the Web carrier's own bound is
 * 300 MiB, so the cap could still cost a full 300 MiB copy. These tests drive the
 * real route: a chunked body is counted while it streams in, and a declared
 * Content-Length over the cap is refused without reading either.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

async function fixture(t, capabilities = ['asset-upload']) {
  const root = await mkdtemp(join(tmpdir(), 'review-upload-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewDir = join(root, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(reviewDir, 'index.html'), '{{REVIEW_BRIDGE}}\n')
  const surface = join(reviewDir, 'surface.json')
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'probe/upload',
    title: 'Upload probe',
    project_root: '..',
    dir: '..',
    entry: 'review/index.html',
    feedback: 'review/feedback.json',
    wake: { mode: 'queue', text: '{unit}' },
    capabilities,
  }))
  const routes = []
  const ctx = {
    inject(_names, fn) {
      fn({
        connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
        effect: (run) => (run() ?? (() => {})),
        logger: {},
        get: () => undefined,
      })
    },
    effect: (run) => (run() ?? (() => {})),
    get: () => undefined,
    logger: {},
  }
  apply(ctx, {})
  return { root, surface, routes }
}

const uploadRouteOf = (f) => f.routes.find((route) => route.path === '/api/review.upload')

function uploadRequest(surface, rel, body, headers = {}) {
  const url = new URL('http://dsh.local/api/review.upload')
  url.searchParams.set('surface', surface)
  url.searchParams.set('rel', rel)
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...headers },
    body,
  })
}

test('a body over the cap is refused while streaming, and nothing lands on disk', async (t) => {
  const f = await fixture(t)
  const oversized = new Uint8Array(17 * 1024 * 1024)
  const response = await uploadRouteOf(f).fetch(uploadRequest(f.surface, 'uploads/big.bin', oversized))
  assert.equal(response.status, 413)
  const body = await response.json()
  assert.equal(body.limit, 16 * 1024 * 1024)
  assert.ok(body.bytes > body.limit)
  await assert.rejects(() => stat(join(f.root, 'uploads', 'big.bin')), /ENOENT/)
})

test('a declared Content-Length over the cap is refused before reading', async (t) => {
  const f = await fixture(t)
  // A tiny body with a lying header: the point is the early refusal, not the byte
  // count, so it does not matter that the declared length is not real.
  const response = await uploadRouteOf(f).fetch(uploadRequest(
    f.surface,
    'uploads/declared.bin',
    new Uint8Array([1, 2, 3]),
    { 'content-length': String(32 * 1024 * 1024) },
  ))
  assert.equal(response.status, 413)
  await assert.rejects(() => stat(join(f.root, 'uploads', 'declared.bin')), /ENOENT/)
})

test('an in-budget upload still writes exactly those bytes', async (t) => {
  const f = await fixture(t)
  const bytes = new Uint8Array([0, 1, 127, 255])
  const response = await uploadRouteOf(f).fetch(uploadRequest(f.surface, 'uploads/small.bin', bytes))
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.bytes, bytes.length)
  assert.deepEqual(new Uint8Array(await readFile(join(f.root, 'uploads', 'small.bin'))), bytes)
})

test('a surface without the capability cannot upload even by direct call', async (t) => {
  const f = await fixture(t, [])
  const response = await uploadRouteOf(f).fetch(
    uploadRequest(f.surface, 'uploads/nope.bin', new Uint8Array([1])),
  )
  assert.equal(response.status, 403)
  await assert.rejects(() => stat(join(f.root, 'uploads', 'nope.bin')), /ENOENT/)
})
