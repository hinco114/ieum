// 임베딩 모델 전용 자식 프로세스 — GPU(Vulkan) 드라이버는 모델을 내려도 프로세스 안에 약 300MB 를 붙잡고 있어서,
// 한동안 안 쓰면 프로세스째 끝내야 메모리가 통째로 돌아온다. 서버(engine.mjs)가 fork 로 띄운다.
//   argv: [entry.mjs file URL, 모델 경로]
//   요청 { id, op:'query', text } → { id, vec: Float32Array }
//        { id, op:'section', title, body } → { id, vecs: Float32Array[] }   (900 토큰 조각, 15% 겹침)
import { cpus } from 'node:os'

const [entry, modelPath] = process.argv.slice(2)
// qmd 와 같은 값 — 900 토큰 조각, 15% 겹침, 컨텍스트 2048
const CHUNK_TOKENS = 900
const OVERLAP_TOKENS = 135
const CONTEXT = 2048

const { getLlama } = await import(entry)
// build:'never' — 맞는 미리 빌드본이 없을 때 llama.cpp 를 소스에서 빌드하러 가지 않는다(CMake·컴파일러 없는 PC 에서 수 분 멈춤)
const llama = await getLlama({ build: 'never' })
// Vulkan·CUDA 처럼 GPU 메모리가 따로 있으면 파일 매핑(mmap) 사본이 메모리에 그대로 남는다(Windows Vulkan 실측 +450MB) — 매핑하지 않는다.
// CPU 만 쓰거나 맥(Metal — CPU·GPU 가 메모리를 같이 씀)은 매핑이 낫다: 매핑한 파일을 그대로 쓰고, OS 가 필요하면 회수할 수 있다
const model = await llama.loadModel({ modelPath, ...(llama.gpu && llama.gpu !== 'metal' ? { useMmap: false } : {}) })
// 색인 만들 때 병렬로 — 코어를 나눠 쓴다
const n = llama.gpu ? 1 : Math.max(1, Math.min(4, Math.floor(cpus().length / 4)))
const threads = llama.gpu ? undefined : Math.max(1, Math.floor(cpus().length / n))
const free = []
for (let i = 0; i < n; i++) free.push(await model.createEmbeddingContext({ contextSize: CONTEXT, ...(threads ? { threads } : {}) }))
const waiting = []
const take = () => (free.length ? Promise.resolve(free.pop()) : new Promise(r => waiting.push(r)))
const give = c => (waiting.length ? waiting.shift()(c) : free.push(c))

const normalize = v => {
  const a = Float32Array.from(v)
  let s = 0
  for (const x of a) s += x * x
  s = Math.sqrt(s) || 1
  for (let i = 0; i < a.length; i++) a[i] /= s
  return a
}
async function embed(text) {
  // 안전하게 컨텍스트 안으로 자른다
  const toks = model.tokenize(text)
  if (toks.length > CONTEXT - 16) text = model.detokenize(toks.slice(0, CONTEXT - 16))
  const ctx = await take()
  try {
    return normalize((await ctx.getEmbeddingFor(text)).vector)
  } finally {
    give(ctx)
  }
}
function chunksOf(title, body) {
  const toks = model.tokenize(body)
  if (toks.length <= CHUNK_TOKENS) return [`${title}\n${body}`]
  const out = []
  for (let s = 0; s < toks.length; s += CHUNK_TOKENS - OVERLAP_TOKENS) {
    out.push(`${title}\n${model.detokenize(toks.slice(s, s + CHUNK_TOKENS))}`)
    if (s + CHUNK_TOKENS >= toks.length) break
  }
  return out
}

process.on('message', async m => {
  try {
    if (m.op === 'query') return process.send({ id: m.id, vec: await embed(m.text) })
    if (m.op === 'section') {
      const vecs = []
      for (const ch of chunksOf(m.title, m.body)) vecs.push(await embed(ch))
      return process.send({ id: m.id, vecs })
    }
  } catch (e) {
    process.send({ id: m.id, error: String(e?.message ?? e) })
  }
})
// 서버가 죽으면 같이 끝난다
process.on('disconnect', () => process.exit(0))
process.send({ ready: true, gpu: llama.gpu || 'cpu', contexts: n })
