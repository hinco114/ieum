// 검색 엔진 본체 — qmd 없이 두 가지만 직접 쓴다.
//   · node-llama-cpp : Qwen3-Embedding-0.6B(GGUF) 로 임베딩 (qmd 와 같은 모델·같은 입력 형식)
//   · kiwi-nlp       : 한국어 형태소 → BM25
// 색인은 메모리에 들고(섹션 수천 개 × 1024차원 ≈ 수십 MB, 전수 코사인 수 ms), 섹션 내용 해시로 디스크에 캐시한다.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fork } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { EMBED_MODEL_FILE, KIWI_FILES, paths } from './paths.mjs'

const P = paths()
const lib = async name => import(pathToFileURL(join(P.lib, 'entry.mjs')).href).then(m => m[name])

// 조각 나누기(900 토큰, 15% 겹침)·컨텍스트 2048 은 embed-worker.mjs 에
const QUERY_PREFIX = 'Instruct: Retrieve relevant documents for the given query\nQuery: '
const TITLE_WEIGHT = 3
// 형태소를 뽑는 방식(kiwi-worker.mjs)이 바뀌면 올린다 — 캐시의 형태소만 다시 뽑고 임베딩은 그대로 쓴다
const TOK_VER = 2

const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16)

// ── 모델 올리기·내리기 ────────────────────────────────────────────
// Kiwi(약 800MB)와 임베딩 모델(약 430MB)은 쓸 때만 올려 두고, IDLE_MS 동안 안 쓰면 내린다(qmd 와 같은 방식).
// 다시 올리는 데 Kiwi 약 2초 · 모델 약 1초(GPU) — 쉬다가 처음 떠올릴 때만 그만큼 늦다.
const IDLE_MS = Math.max(1, Number(process.env.IEUM_RECALL_IDLE_MIN || 5)) * 60_000
let busy = 0
let lastRecall = 0 // 마지막으로 기억을 떠올린 때 — 정리가 끝났을 때 바로 내릴지 정한다
let idleTimer = null
let onUnload = () => {}
export const setUnloadLog = f => { onUnload = f }
const touch = () => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { if (!busy) void unloadModels() }, IDLE_MS)
  idleTimer.unref?.()
}
/** 모델을 쓰는 동안에는 내리지 않는다 */
const using = async fn => {
  busy++
  try { return await fn() } finally { busy--; touch() }
}
export async function unloadModels(reason = 'idle') {
  if (busy) return
  const had = !!(kiwiWorker || embedChild)
  await unloadKiwi()
  await unloadEmbedder()
  if (had) onUnload(reason)
}
export const modelsLoaded = () => ({ kiwi: !!kiwiWorker, embedder: !!embedChild })

// ── 형태소 (작업 스레드) ──────────────────────────────────────────
let kiwiWorker = null, kiwiReady = null, kiwiSeq = 0
const kiwiWaiting = new Map()
function ensureKiwi() {
  if (kiwiReady) return kiwiReady
  const w = new Worker(new URL('./kiwi-worker.mjs', import.meta.url), {
    workerData: {
      entry: pathToFileURL(join(P.lib, 'entry.mjs')).href,
      wasm: join(P.lib, 'node_modules/kiwi-nlp/dist/kiwi-wasm.wasm'),
      kiwiDir: P.kiwiDir,
      files: Object.keys(KIWI_FILES),
    },
  })
  kiwiWorker = w
  kiwiReady = new Promise((resolve, reject) => {
    w.on('message', m => {
      if (m.ready) return resolve()
      const p = kiwiWaiting.get(m.id)
      if (!p) return
      kiwiWaiting.delete(m.id)
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.out)
    })
    const fail = e => {
      reject(e)
      for (const p of kiwiWaiting.values()) p.reject(e)
      kiwiWaiting.clear()
      if (kiwiWorker === w) { kiwiWorker = null; kiwiReady = null }
    }
    w.on('error', fail)
    w.on('exit', code => fail(new Error(`kiwi worker exit ${code}`)))
  })
  return kiwiReady
}
async function unloadKiwi() {
  const w = kiwiWorker
  kiwiWorker = null
  kiwiReady = null
  if (w) await w.terminate().catch(() => {})
}
/** 여러 글을 한 번에 형태소로(검색에 쓰는 것만) */
export const tokensMany = texts => using(async () => {
  await ensureKiwi()
  const id = ++kiwiSeq
  return new Promise((resolve, reject) => {
    kiwiWaiting.set(id, { resolve, reject })
    kiwiWorker.postMessage({ id, texts })
  })
})
export const tokens = async text => (await tokensMany([text]))[0]

// ── 임베딩 (자식 프로세스) ────────────────────────────────────────
// GPU(Vulkan) 드라이버는 모델을 내려도 프로세스 안에 약 300MB 를 남긴다 — 그래서 모델은 따로 띄운 프로세스(embed-worker.mjs)에
// 두고, 내릴 때는 프로세스째 끝낸다
let embedChild = null, embedderReady = null, embedSeq = 0, embedContexts = 1
const embedWaiting = new Map()
function ensureEmbedder() {
  embedderReady ??= new Promise((resolve, reject) => {
    const ch = fork(fileURLToPath(new URL('./embed-worker.mjs', import.meta.url)), [pathToFileURL(join(P.lib, 'entry.mjs')).href, P.embedModel], {
      execArgv: ['--use-system-ca'],
      serialization: 'advanced', // Float32Array 를 그대로 주고받는다
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    })
    embedChild = ch
    ch.on('message', m => {
      if (m.ready) { embedContexts = m.contexts; return resolve(m) }
      const p = embedWaiting.get(m.id)
      if (!p) return
      embedWaiting.delete(m.id)
      m.error ? p.reject(new Error(m.error)) : p.resolve(m)
    })
    const fail = e => {
      reject(e)
      for (const p of embedWaiting.values()) p.reject(e)
      embedWaiting.clear()
      if (embedChild === ch) { embedChild = null; embedderReady = null }
    }
    ch.on('error', fail)
    ch.on('exit', code => fail(new Error(`embed worker exit ${code}`)))
  })
  return embedderReady
}
async function unloadEmbedder() {
  const ch = embedChild
  embedChild = null
  embedderReady = null
  if (ch) ch.kill()
}
const askEmbed = msg => new Promise((resolve, reject) => {
  const id = ++embedSeq
  embedWaiting.set(id, { resolve, reject })
  embedChild.send({ id, ...msg })
})
export const embedQuery = q => using(async () => {
  lastRecall = Date.now()
  await ensureEmbedder()
  return (await askEmbed({ op: 'query', text: QUERY_PREFIX + q })).vec
})
/** 섹션 하나 → 조각 벡터들(조각 나누기는 모델 토크나이저로, 자식 프로세스에서) */
const embedSection = async (title, body) => (await askEmbed({ op: 'section', title, body })).vecs

// ── 색인 ──────────────────────────────────────────────────────────
// index = { ids:[], meta:{id:{hash,title,tf,len}}, vecs: Float32Array(전체 조각), vecSec: Int32Array(조각→섹션 번호), dim, df, avgLen }
export let index = null

function loadCache() {
  try {
    const meta = JSON.parse(readFileSync(join(P.cache, 'index.json'), 'utf8'))
    const buf = readFileSync(join(P.cache, 'vectors.bin'))
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    if (meta.model && meta.model !== EMBED_MODEL_FILE) return { dim: 0, byHash: new Map() } // 다른 모델로 만든 캐시는 버린다
    const byHash = new Map()
    const today = dayNo()
    for (const e of meta.entries) byHash.set(e.hash, { ...e, seen: e.seen ?? today, vecs: all.subarray(e.off * meta.dim, (e.off + e.n) * meta.dim) })
    return { dim: meta.dim, byHash }
  } catch {
    return { dim: 0, byHash: new Map() }
  }
}

function saveCache(entries, dim) {
  mkdirSync(P.cache, { recursive: true })
  let total = 0
  for (const e of entries) total += e.n
  const all = new Float32Array(total * dim)
  let off = 0
  const meta = entries.map(e => {
    all.set(e.vecs, off * dim)
    const m = { hash: e.hash, n: e.n, off, tf: e.tf, len: e.len, seen: e.seen, tok: e.tok }
    off += e.n
    return m
  })
  writeFileSync(join(P.cache, 'vectors.bin.tmp'), Buffer.from(all.buffer))
  writeFileSync(join(P.cache, 'index.json.tmp'), JSON.stringify({ model: EMBED_MODEL_FILE, dim, entries: meta }))
  renameSync(join(P.cache, 'vectors.bin.tmp'), join(P.cache, 'vectors.bin'))
  renameSync(join(P.cache, 'index.json.tmp'), join(P.cache, 'index.json'))
}

/** sections 폴더(split.mjs 결과)로 색인을 만든다. 내용이 같은 섹션은 캐시를 다시 쓴다. */
// 지난 색인의 섹션들(해시 → 형태소·벡터) — 처음 한 번만 디스크에서 읽고, 그다음부터는 메모리에서 다시 쓴다
let memCache = null
// 색인에서 빠진 조각의 벡터도 이만큼은 캐시에 남겨 둔다 — 쪼개는 방식이 다른 버전 사이를 오가거나
// 글을 고쳤다가 되돌려도 다시 임베딩하지 않도록. seen = 마지막으로 색인에 있던 날(일 단위)
const KEEP_DAYS = 7
const dayNo = () => Math.floor(Date.now() / 86_400_000)
const tick = () => new Promise(r => setImmediate(r))
// 섹션의 낱말 빈도 — 제목 낱말은 TITLE_WEIGHT 배
async function termsOf(e) {
  const [title, ...rest] = e.text.split('\n')
  const [bodyToks, titleToks] = await tokensMany([rest.join('\n').trim(), title])
  const tf = {}
  for (const t of bodyToks) tf[t] = (tf[t] ?? 0) + 1
  for (const t of titleToks) tf[t] = (tf[t] ?? 0) + TITLE_WEIGHT
  e.tf = tf
  e.len = Object.values(tf).reduce((a, b) => a + b, 0)
  e.tok = TOK_VER
}
// 한 섹션의 형태소를 못 뽑아도 색인 전체를 멈추지 않는다. Kiwi(WASM)는 한 번 예외를 던지면 안쪽 상태가 깨져
// 다음 글도 줄줄이 실패할 수 있어서 스레드를 새로 띄워 한 번 더 해 본다. 그래도 안 되면 그 섹션은 의미로만 찾힌다.
// Kiwi 는 같은 글엔 늘 같은 결과라 글이 그대로면 다시 해 봐야 소용없다 — 지금 버전으로 표시해 두고, 글이 바뀌면(해시가 달라지면) 다시 뽑는다
async function safeTerms(e, log) {
  for (let i = 0; i < 2; i++) {
    try { return await termsOf(e) } catch (err) {
      log(`tokenize ${i ? 'skip' : 'retry'} ${e.id} (${e.text.length}자): ${String(err?.message ?? err).slice(0, 80)}`)
      await unloadKiwi()
    }
  }
  e.tf = {}
  e.len = 0
  e.tok = TOK_VER
}

/**
 * sections 폴더(split.mjs 결과)로 색인을 만든다. 내용이 같은 섹션은 캐시를 다시 쓴다.
 * @param texts splitVault 가 돌려준 섹션 내용(id → 글) — 있으면 섹션 파일을 다시 읽지 않는다
 */
export async function build(log = () => {}, texts = null) {
  const sdir = join(P.sections, 's')
  const cache = memCache ?? loadCache()
  const ids = texts ? [...texts.keys()] : readdirSync(sdir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))
  const entries = []
  const todo = []
  const retok = [] // 벡터는 그대로 쓰고 형태소만 다시 뽑을 섹션(TOK_VER 가 바뀐 경우)
  const today = dayNo()
  for (const [i, id] of ids.entries()) {
    if (i % 300 === 0) await tick() // 색인 중에도 /recall·/health 에 답하도록
    const text = texts?.get(id) ?? readFileSync(join(sdir, `${id}.md`), 'utf8')
    const hash = sha(text)
    const c = cache.byHash.get(hash)
    const e = { id, hash, text, n: c?.n ?? 0, vecs: c?.vecs, tf: c?.tf, len: c?.len ?? 0, seen: today, tok: c?.tok }
    entries.push(e)
    if (!c) todo.push(e)
    else if (c.tok !== TOK_VER) retok.push(e)
  }
  // 새로 바뀐 섹션만: 형태소 + 조각 임베딩
  let done = 0, dim = cache.dim, embedOk = true
  const queue = [...todo]
  const t0 = Date.now()
  const worker = async () => {
    for (let e; (e = queue.shift()); ) {
      // 색인 중에도 /recall·/health 에 답하도록 섹션마다 이벤트 루프에 한 번 양보한다
      await new Promise(r => setImmediate(r))
      const [title, ...rest] = e.text.split('\n')
      const body = rest.join('\n').trim()
      await safeTerms(e, log)
      // 한 섹션이 실패해도(이상한 글자 등)·모델을 못 올려도 전체 색인을 멈추지 않는다 — 그 섹션은 키워드로만 찾히고,
      // 캐시에 남기지 않아 다음 정리 때 다시 임베딩한다
      try {
        if (!embedOk) throw new Error('embed model unavailable')
        const vs = await embedSection(title.replace(/^#\s*/, ''), body)
        dim = vs[0].length
        e.n = vs.length
        e.vecs = new Float32Array(vs.length * dim)
        vs.forEach((v, i) => e.vecs.set(v, i * dim))
      } catch (err) {
        e.n = 0
        e.vecs = new Float32Array(0)
        e.noVec = true
        if (embedOk) log(`embed skip ${e.id}: ${String(err?.message ?? err).slice(0, 80)}`)
      }
      if (++done % 200 === 0) log(`embed ${done}/${todo.length} (${Math.round((Date.now() - t0) / 1000)}s)`)
    }
  }
  // 바뀐 섹션이 있을 때만 Kiwi·모델을 올린다 — 없으면(대부분의 정리) 아무것도 올리지 않는다.
  // 형태소만 다시 뽑을 거면 Kiwi 만 올린다
  if (todo.length || retok.length) {
    await using(async () => {
      await ensureKiwi()
      if (retok.length) {
        const t1 = Date.now()
        for (const [i, e] of retok.entries()) {
          if (i % 20 === 0) await tick()
          await safeTerms(e, log)
        }
        log(`re-tokenized ${retok.length} sections (${Math.round((Date.now() - t1) / 1000)}s)`)
      }
      if (!todo.length) return
      await ensureEmbedder().catch(err => {
        embedOk = false
        log(`embed model unavailable — keyword only this time: ${String(err?.message ?? err).slice(0, 120)}`)
      })
      await Promise.all(Array.from({ length: embedOk ? embedContexts : 1 }, () => worker()))
    })
    // 정리하려고 올린 거면 끝나자마자 내린다. 최근 IDLE_MS 안에 기억을 떠올린 적이 있으면 이어질 질문을 위해 남겨 둔다
    if (Date.now() - lastRecall > IDLE_MS) await unloadModels('refresh done')
  }
  // 이번 색인에 없는 조각 — KEEP_DAYS 안에 본 것은 벡터를 남겨 둔다(색인에는 넣지 않는다)
  const live = new Set(entries.map(e => e.hash))
  const kept = [...cache.byHash.values()].filter(c => !live.has(c.hash) && today - (c.seen ?? today) < KEEP_DAYS && c.n && c.vecs)
  const stored = [...entries.filter(e => !e.noVec), ...kept]
  // 바뀐 게 있거나, 날이 바뀌어 seen 을 고쳐 써야 할 때만 디스크에 쓴다(벡터 파일이 커서 정리 때마다 쓰지 않는다)
  const stale = entries.some(e => !e.noVec && cache.byHash.get(e.hash)?.seen !== today)
  if (todo.length || retok.length || stale || new Set(stored.map(e => e.hash)).size !== cache.byHash.size) {
    await tick()
    saveCache(stored, dim)
    await tick()
  }
  memCache = { dim, byHash: new Map(stored.map(e => [e.hash, e])) }
  pending = entries.filter(e => e.noVec).length
  // 메모리 색인으로 조립
  const total = entries.reduce((a, e) => a + e.n, 0)
  const vecs = new Float32Array(total * dim)
  const vecSec = new Int32Array(total)
  const df = new Map()
  let off = 0, lenSum = 0
  entries.forEach((e, si) => {
    vecs.set(e.vecs, off * dim)
    vecSec.fill(si, off, off + e.n)
    off += e.n
    for (const t of Object.keys(e.tf)) df.set(t, (df.get(t) ?? 0) + 1)
    lenSum += e.len
  })
  index = { ids: entries.map(e => e.id), tf: entries.map(e => e.tf), len: entries.map(e => e.len), vecs, vecSec, dim, df, avgLen: lenSum / Math.max(1, entries.length) }
  return { sections: entries.length, embedded: todo.length, chunks: total, ms: Date.now() - t0 }
}

// ── 검색 ──────────────────────────────────────────────────────────
/** 의미: 섹션 id 를 점수순으로 + 섹션별 코사인(섹션 점수 = 가장 잘 맞는 조각) */
export async function vecSearch(q, limit) {
  if (!index) return { ids: [], cos: new Map() }
  const qv = await embedQuery(q)
  const { vecs, vecSec, dim, ids } = index
  const best = new Float32Array(ids.length).fill(-2)
  for (let i = 0, n = vecSec.length; i < n; i++) {
    let s = 0
    const o = i * dim
    for (let d = 0; d < dim; d++) s += vecs[o + d] * qv[d]
    if (s > best[vecSec[i]]) best[vecSec[i]] = s
  }
  const cos = new Map(ids.map((id, i) => [id, best[i]]))
  return { ids: [...best.keys()].sort((a, b) => best[b] - best[a]).slice(0, limit).map(i => ids[i]), cos }
}

/**
 * 키워드: Kiwi 토큰 OR 매칭 BM25 (k1 1.2, b .75)
 * @returns {{ ids: string[], score: Map<string, number>, rare: Map<string, number> }}
 *   rare = 드문 단어(사람 이름·고유어처럼 전체 조각의 0.3% 이하에만 나오는 것)가 정확히 들어 있는 조각 → 그런 단어 수
 */
export async function lexSearch(q, limit) {
  const none = { ids: [], score: new Map(), rare: new Map() }
  if (!index) return none
  lastRecall = Date.now()
  const qt = [...new Set(await tokens(q))]
  if (!qt.length) return none
  const { tf, len, df, avgLen, ids } = index
  const N = ids.length
  const rareDf = Math.max(3, Math.floor(N * 0.003))
  const scores = new Map()
  const rare = new Map()
  for (const t of qt) {
    const n = df.get(t)
    if (!n) continue
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
    const isRare = n <= rareDf && t.length >= 2
    for (let i = 0; i < N; i++) {
      const f = tf[i][t]
      if (!f) continue
      scores.set(i, (scores.get(i) ?? 0) + (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (len[i] / avgLen))))
      if (isRare) rare.set(ids[i], (rare.get(ids[i]) ?? 0) + 1)
    }
  }
  const top = [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit)
  return { ids: top.map(([i]) => ids[i]), score: new Map(top.map(([i, v]) => [ids[i], v])), rare }
}

// 모델을 못 올려 임베딩 못 한 섹션 수 — 다음 정리 때 파일이 안 바뀌었어도 다시 시도한다
let pending = 0
export const pendingEmbeds = () => pending
export const ready = () => !!index
export const hasModels = () => existsSync(P.embedModel) && Object.keys(KIWI_FILES).every(f => existsSync(join(P.kiwiDir, f)))
