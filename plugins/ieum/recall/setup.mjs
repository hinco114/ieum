import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { EMBED_MODEL_FILE, EMBED_MODEL_SHA256, EMBED_MODEL_URL, KIWI_FILES, KIWI_VERSION, kiwiUrl, paths } from './paths.mjs'

const NODE_LINE = 'latest-v22.x'
const DEPS = { 'node-llama-cpp': '3.18.1', 'kiwi-nlp': KIWI_VERSION }
const P = paths()
const HERE = dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'
const MIRROR = (process.env.IEUM_RECALL_MIRROR || '').replace(/\/$/, '')
const say = m => console.log(`[ieum recall] ${m}`)
// Windows 는 OS 기본 tar(bsdtar — zip 도 푼다). Git Bash 의 GNU tar 는 'C:' 를 원격 호스트로 읽는다
const TAR = isWin ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar'
const nodeBin = () => join(P.node, isWin ? 'node.exe' : 'bin/node')
const npmCli = () => join(P.node, isWin ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js')
const sha256File = f => {
  const h = createHash('sha256')
  h.update(readFileSync(f))
  return h.digest('hex')
}

async function download(src, dest) {
  const url = src
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  mkdirSync(dirname(dest), { recursive: true })
  await pipeline(Readable.fromWeb(r.body), createWriteStream(`${dest}.part`))
  renameSync(`${dest}.part`, dest)
}

// sha256 이 맞는 파일을 dest 에 둔다: 이미 있으면 그대로 → 다른 곳에 받아 둔 사본(qmd 캐시 등) → 미러 → 원본 주소
async function ensureFile(dest, sha, urls, reuse = []) {
  if (existsSync(dest) && sha256File(dest) === sha) return false
  for (const src of reuse) {
    if (existsSync(src) && sha256File(src) === sha) {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      return true
    }
  }
  let last
  // 받을 곳 목록은 정말 받아야 할 때만 만든다(git 로그인을 괜히 묻지 않게)
  for (const src of typeof urls === 'function' ? urls() : urls) {
    try {
      await download(src, dest)
      if (sha256File(dest) === sha) { say(`받음${src.via ? `(${src.via})` : ''}: ${(src.url ?? src).replace(/^https:\/\/([^/]+).*\/([^/]+)$/, '$1 … $2')}`); return true }
      last = new Error(`체크섬 불일치: ${src.url ?? src}`)
    } catch (e) { last = e }
  }
  rmSync(dest, { force: true })
  throw last
}

// 1) Node 22
async function ensureNode() {
  if (existsSync(nodeBin())) return say(`Node 있음: ${execFileSync(nodeBin(), ['--version']).toString().trim()}`)
  const plat = isWin ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const ext = isWin ? 'zip' : 'tar.gz'
  const base = `https://nodejs.org/dist/${NODE_LINE}`
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
  const line = sums.split('\n').find(l => l.endsWith(`-${plat}-${arch}.${ext}`))
  if (!line) throw new Error(`Node 22 배포본을 못 찾았다 (${plat}-${arch})`)
  const [sha, file] = line.trim().split(/\s+/)
  const tmp = join(P.home, file)
  say(`Node 받는 중: ${file}`)
  await ensureFile(tmp, sha, [`${base}/${file}`])
  const ex = join(P.home, '_node')
  rmSync(ex, { recursive: true, force: true })
  mkdirSync(ex, { recursive: true })
  execFileSync(TAR, ['-xf', tmp, '-C', ex])
  rmSync(tmp)
  rmSync(P.node, { recursive: true, force: true })
  renameSync(join(ex, readdirSync(ex)[0]), P.node)
  rmSync(ex, { recursive: true, force: true })
  say(`Node 설치: ${execFileSync(nodeBin(), ['--version']).toString().trim()}`)
}

// 이후 단계는 Node 22 + OS 인증서로 다시 실행
function reexecUnderNode22() {
  if (process.env.IEUM_RECALL_STAGE2) return false
  const r = spawn(nodeBin(), ['--use-system-ca', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, IEUM_RECALL_STAGE2: '1' },
  })
  r.on('close', code => process.exit(code ?? 1))
  return true
}

// 2) npm 의존성 — 설치 스크립트는 끈다(node-llama-cpp 의 바이너리는 플랫폼별 npm 패키지로 이미 온다)
function ensureLib() {
  const pj = join(P.lib, 'package.json')
  const want = JSON.stringify({ name: 'ieum-recall-lib', private: true, type: 'module', dependencies: DEPS })
  const have = existsSync(pj) ? readFileSync(pj, 'utf8') : ''
  if (have === want && existsSync(join(P.lib, 'entry.mjs')) && Object.keys(DEPS).every(d => existsSync(join(P.lib, 'node_modules', d)))) return say('라이브러리 있음')
  mkdirSync(P.lib, { recursive: true })
  writeFileSync(pj, want)
  say(`라이브러리 설치 중: ${Object.entries(DEPS).map(([k, v]) => `${k}@${v}`).join(', ')}`)
  execFileSync(process.execPath, [npmCli(), 'install', '--cache', join(P.home, 'npm-cache'), '--ignore-scripts', '--no-fund', '--no-audit', '--omit=dev'], { cwd: P.lib, stdio: 'inherit' })
  // 엔진이 이 폴더의 node_modules 를 쓰도록 진입점 하나(ESM 은 import 하는 파일 기준으로 패키지를 찾는다)
  writeFileSync(join(P.lib, 'entry.mjs'), "export { getLlama } from 'node-llama-cpp'\nexport { KiwiBuilder, Match } from 'kiwi-nlp'\n")
}

// 3) 모델
async function ensureModels() {
  const qmdCache = join(homedir(), '.cache', 'qmd', 'models') // 예전에 qmd 를 써 봤다면 같은 파일을 다시 받지 않는다
  if (await ensureFile(P.embedModel, EMBED_MODEL_SHA256,
    () => [...(MIRROR ? [`${MIRROR}/${EMBED_MODEL_FILE}`] : []), EMBED_MODEL_URL],
    [join(qmdCache, `hf_Qwen_${EMBED_MODEL_FILE}`)])) say(`임베딩 모델 준비: ${EMBED_MODEL_FILE} (${(statSync(P.embedModel).size / 1e6).toFixed(0)}MB)`)
  else say('임베딩 모델 있음')
  for (const [f, sha] of Object.entries(KIWI_FILES)) {
    await ensureFile(join(P.kiwiDir, f), sha, () => [...(MIRROR ? [`${MIRROR}/kiwi/${f}`] : []), kiwiUrl(f)], [join(qmdCache, 'kiwi-nlp', KIWI_VERSION, 'cong', f)])
  }
  say('Kiwi 모델 있음')
}

mkdirSync(P.home, { recursive: true })
if (!process.env.IEUM_RECALL_STAGE2 && (typeof fetch !== 'function' || +process.versions.node.split('.')[0] < 18)) {
  console.error(`[ieum recall] Node 18 이상에서 실행해야 한다(지금 ${process.version}) — 설치될 엔진은 따로 받은 Node 22 로 돈다`)
  process.exit(1)
}
if (!process.env.IEUM_RECALL_STAGE2) {
  await ensureNode()
  if (reexecUnderNode22()) await new Promise(() => {})
} else {
  ensureLib()
  await ensureModels()
  // 확인: 라이브러리가 실제로 열리는지
  execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(new URL(`file:///${join(P.lib, 'entry.mjs').replace(/\\/g, '/')}`).href)}); console.log('[ieum recall] 라이브러리 확인:', Object.keys(m).join(', '))`], { stdio: 'inherit' })
  say(`설치 완료 → ${P.home}`)

}
