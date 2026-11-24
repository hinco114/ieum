// Kiwi(한국어 형태소) 전용 작업 스레드 — 모델을 올리면 메모리를 약 800MB 쓴다.
// 서버 본체와 따로 두고, 한동안 안 쓰면 스레드째 끝내서 메모리를 통째로 돌려준다(WASM 메모리는 줄어들지 않아서).
//   workerData = { entry: lib/entry.mjs 의 file URL, wasm, kiwiDir, files: [모델 파일 이름] }
//   요청 { id, texts: string[] } → 응답 { id, out: string[][] }  (검색에 쓰는 형태소만, 소문자)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

const SEARCHABLE = ['N', 'XR', 'SL', 'SH', 'SN'] // 명사·어근·외국어·한자·숫자

const { KiwiBuilder, Match } = await import(workerData.entry)
const builder = await KiwiBuilder.create(workerData.wasm)
const modelFiles = {}
for (const f of workerData.files) modelFiles[f] = new Uint8Array(readFileSync(join(workerData.kiwiDir, f)))
const kiwi = await builder.build({ modelFiles, modelType: 'cong', integrateAllomorph: true })

// 사람 이름처럼 Kiwi 가 모르는 낱말은 한 글자씩 잘린다(강유림님과 → 강/유/림, 이서희 → 이/서/희).
// 한 글자 조각은 아래에서 버리므로 이름이 색인에서 통째로 사라지고, 문맥에 따라 자르는 방식도 달라진다
// (강유림 → 강/유리). 그래서 한 어절 안에서 이어진 명사(앞에 붙은 관형사 포함) 가운데 한 글자 조각이 끼어 있으면
// 원문의 그 구간을 한 낱말로 더 넣는다 — 묻는 쪽과 기록 쪽이 같은 낱말(강유림)로 만난다
const NOUNISH = t => t.tag.startsWith('N') || t.tag === 'MM'
const joined = (text, toks) => {
  const out = []
  let run = []
  const flush = () => {
    if (run.length >= 2 && run.some(t => t.tag.startsWith('N')) && run.some(t => t.length === 1 && /[가-힣]/.test(text[t.position]))) {
      const w = text.slice(run[0].position, Math.max(...run.map(t => t.position + t.length))).toLowerCase()
      if (w.length >= 2 && w.length <= 12 && /^[가-힣]+$/.test(w)) out.push(w)
    }
    run = []
  }
  for (const t of toks) {
    const prev = run[run.length - 1]
    const next = NOUNISH(t) && (!prev || (t.wordPosition === prev.wordPosition && t.position <= prev.position + prev.length))
    if (!next) flush()
    if (NOUNISH(t)) run.push(t)
  }
  flush()
  return out
}

const tokens = raw => {
  // 짝 잃은 서로게이트가 섞인 글은 WASM 이 UTF-8 로 못 바꿔 예외를 던진다 — �로 바꿔 넘긴다
  const text = raw.toWellFormed ? raw.toWellFormed() : raw
  const out = []
  const toks = kiwi.tokenize(text, Match.allWithNormalizing)
  for (const t of toks) {
    if (!SEARCHABLE.some(p => t.tag.startsWith(p))) continue
    const s = t.str.trim().toLowerCase()
    if (!s || !/[\p{L}\p{N}]/u.test(s) || (s.length === 1 && /[가-힣]/.test(s))) continue // 한 글자 한글은 조사·어미 찌꺼기
    out.push(s)
  }
  out.push(...joined(text, toks)) // 나올 때마다 넣는다(여러 번 나오면 그만큼 점수)
  return out
}

parentPort.on('message', ({ id, texts }) => {
  try {
    parentPort.postMessage({ id, out: texts.map(t => tokens(t)) })
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message ?? e) })
  }
})
parentPort.postMessage({ ready: true })
