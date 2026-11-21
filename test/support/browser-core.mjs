/**
 * 真浏览器验收的两个前置：一份 planners-review-core，和一份 Playwright。
 *
 * 三条验收（草稿回读、跨对话的标签归属、外壳控件）要的是同一句话：缺任一项时
 * 显式 skip 并说明原因，绝不伪造通过。这句话只写一次。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadPlaywright } from '../browser/draft-reload.browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** The same search the plugin does, narrowed to the copies a test can rely on. */
export function coreDir() {
  const candidates = [
    process.env.DSH_REVIEW_CORE_DIR,
    join(homedir(), '.dsh', 'skills', 'planners-review-core'),
    join(homedir(), '.claude', 'skills', 'planners-review-core'),
    join(homedir(), '.codex', 'skills', 'planners-review-core'),
    resolve(here, '../../../../02-skills-library/00-system/planners-review-core'),
  ].filter((value) => typeof value === 'string' && value !== '')
  return candidates.find((dir) => existsSync(join(dir, 'assets', 'review-bridge.js'))) ?? ''
}

export const core = coreDir()

const { playwright, error } = loadPlaywright()

/** `false` when both are there; otherwise one sentence naming what is missing. */
export const skip = core === ''
  ? 'requires planners-review-core (set DSH_REVIEW_CORE_DIR)'
  : playwright === undefined
    ? error
    : false
