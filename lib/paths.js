/**
 * 路径围栏 —— 唯一一处回答「这个路径在不在这个根里面」。
 *
 * 三个动作，一种答案形状：
 *
 *   canRead(root, rel)    能不能读这个文件          → { ok, real } / { ok:false, reason }
 *   canWrite(root, target) 能不能往这个位置写        → { ok, target } / { ok:false, reason }
 *   landingOf(root, target) 还没写出来的文件落在哪   → { ok, target } / { ok:false, reason }
 *
 * 理由只有三种：`escape`（越界）、`missing`（不存在）、`symlink`（经过符号链接）。
 * 调用方只做一件事：照着理由回 403 或 404（`statusForReason`），不自己拼真实
 * 路径、不自己比前缀。
 *
 * 两条比较都要做，回答的问题不同：
 *   - 先在**字面**路径上问「它看起来是不是在根里」——不像就是 `escape`；
 *   - 再在**真实**路径上问「经过软链之后它还在不在根里」——不在了就是 `symlink`。
 * 只做第一条会被软链骗过；只做第二条会把「根自己就是一条软链」（macOS 的
 * `/tmp` → `/private/tmp`、挂在网盘里的工程）误判成越界。
 */
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

const failure = (reason) => ({ ok: false, reason })

/** 三种理由只对应两个回答：越界与软链都是 403，不存在是 404。 */
export function statusForReason(reason) {
  return reason === 'missing' ? 404 : 403
}

/** The literal candidate a caller asked about, or null when the input itself is malformed. */
function lexicalTarget(root, target) {
  if (typeof target !== 'string' || target === '' || target.includes('\0')) return null
  const lexicalRoot = resolve(root)
  const candidate = isAbsolute(target) ? resolve(target) : resolve(lexicalRoot, target)
  if (candidate !== lexicalRoot && !candidate.startsWith(lexicalRoot + sep)) return null
  return { lexicalRoot, candidate }
}

/** True when `target` is `root` or lives under it (both already resolved/absolute). */
function inside(root, target) {
  return target === root || target.startsWith(root + sep)
}

/**
 * The real absolute place a target occupies, whether or not it exists yet.
 *
 * An existing target is realpath'd (so an existing symlink reports its
 * destination — that IS where a write would land). A target that does not exist
 * yet is resolved by realpath'ing the nearest existing ancestor and appending
 * the missing tail, because the writers are what create the last directories.
 * @returns the real path, or null when no ancestor can be resolved.
 */
async function realLanding(file) {
  const existing = await lstat(file).catch(() => null)
  if (existing !== null) return realpath(file).catch(() => null)
  let dir = dirname(file)
  const tail = [basename(file)]
  for (;;) {
    const real = await realpath(dir).catch(() => null)
    if (real !== null) return join(real, ...tail)
    const parent = dirname(dir)
    if (parent === dir) return null
    tail.unshift(basename(dir))
    dir = parent
  }
}

/**
 * Where a not-yet-written file lands, if it is allowed to land at all.
 * @returns `{ ok:true, target }` or `{ ok:false, reason }`.
 */
export async function landingOf(root, target) {
  const lexical = lexicalTarget(root, target)
  if (lexical === null) return failure('escape')
  const realRoot = await realpath(lexical.lexicalRoot).catch(() => null)
  if (realRoot === null) return failure('missing')
  const real = await realLanding(lexical.candidate)
  if (real === null) return failure('missing')
  if (!inside(realRoot, real)) return failure('symlink')
  return { ok: true, target: real }
}

/**
 * Can a file be written at `target`? Accepts a path relative to `root` or an
 * absolute one. Refuses an existing symlink even when it points back inside:
 * writing through it would put bytes somewhere the caller never named.
 */
export async function canWrite(root, target) {
  const lexical = lexicalTarget(root, target)
  if (lexical === null) return failure('escape')
  const landed = await landingOf(root, target)
  if (!landed.ok) return landed
  const existing = await lstat(lexical.candidate).catch(() => null)
  if (existing?.isSymbolicLink()) return failure('symlink')
  return landed
}

/**
 * Can this existing file be read? The final symlink may point anywhere INSIDE
 * the root (that is still the root's own content); the answer is the real path.
 */
export async function canRead(root, rel) {
  // Reads are always addressed RELATIVE to the root (the asset/page contract);
  // an absolute path here is a caller mistake, not a second way in.
  if (typeof rel !== 'string' || isAbsolute(rel)) return failure('escape')
  const landed = await landingOf(root, rel)
  if (!landed.ok) return landed
  const info = await stat(landed.target).catch(() => null)
  if (info === null || !info.isFile()) return failure('missing')
  return { ok: true, real: landed.target }
}
