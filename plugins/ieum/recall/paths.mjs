// 연상 기억 런타임이 사는 곳 — vault·플러그인 밖(사용자 캐시)
import { homedir } from 'node:os'
import { join } from 'node:path'

export const EMBED_MODEL_FILE = 'Qwen3-Embedding-0.6B-Q8_0.gguf'
export const EMBED_MODEL_SHA256 = '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439'
export const EMBED_MODEL_URL = `https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/${EMBED_MODEL_FILE}`

export const KIWI_VERSION = '0.22.1'
// kiwi-nlp 는 모델을 안 담아 온다 — Kiwi 저장소의 cong 모델(태그 고정, sha256 확인)
export const KIWI_FILES = {
  'combiningRule.txt': 'ae618482b51a93fb60c100ec2a2ca031967ef2c58e3da75b0575261a131f7289',
  'cong.mdl': 'bd9ca89ee1b72e750c8e2166a17c80a0fe3fabd828c78b1f0928486a6b1833a7',
  'default.dict': 'd4293e44b2588d0c3aabbce607a0f41ad3534abd31b34139847b127254e01549',
  'dialect.dict': 'bb6f0ab37dbfcc0fd33dc679121218d24725ae438f31bb362f9b24703e93cda2',
  'extract.mdl': 'a0c92ffc051e43ae497845cdb8d4c8b9e2f359893cb55c67279c76d1d531ee17',
  'multi.dict': 'e9eff7712d163b214c750333a5d388ab77b50ec386ae55b360babcd24c0c3195',
  'sj.morph': '5e3dab2def6d2cc079e21d5477bd610a391c69045d08caf1e0bbeabda8db8d1b',
  'typo.dict': 'aa15e48fcd32886441fc1ff9719a3109d3192e91d4b67efbd64260610d68322d',
}
const KIWI_LFS = new Set(['cong.mdl', 'extract.mdl', 'sj.morph']) // Git LFS 파일은 media 주소로
export const kiwiUrl = f =>
  `https://${KIWI_LFS.has(f) ? 'media.githubusercontent.com/media' : 'raw.githubusercontent.com'}/bab2min/Kiwi/v${KIWI_VERSION}/models/cong/base/${f}`

export function paths() {
  const home = process.env.IEUM_RECALL_HOME || join(homedir(), '.cache', 'ieum-recall')
  return {
    home,
    node: join(home, 'node'), // 휴대용 Node 22 (시스템 Node 버전과 무관하게)
    lib: join(home, 'lib'), // node-llama-cpp · kiwi-nlp
    models: join(home, 'models'),
    embedModel: join(home, 'models', EMBED_MODEL_FILE),
    kiwiDir: join(home, 'models', 'kiwi', KIWI_VERSION),
    sections: join(home, 'sections'),
    cache: process.env.IEUM_INDEX_DIR || join(home, 'cache'), // 섹션별 벡터·토큰 캐시
    state: join(home, 'server.json'),
    log: join(home, 'server.log'),
  }
}
