import { readFileSync } from 'node:fs'
import { build, lexSearch, vecSearch, pendingEmbeds, unloadModels } from './engine.mjs'

const { docs, query } = JSON.parse(readFileSync(0, 'utf8'))
try {
  await build(undefined, new Map(docs))
  if (pendingEmbeds()) throw new Error('일부 임베딩 준비 실패')
  if (query && docs.length) {
    const [lex, vec] = await Promise.all([lexSearch(query, 40), vecSearch(query, 40)])
    const scores = new Map()
    for (const ids of [lex.ids, vec.ids]) {
      ids.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 1 / (60 + i + 1)))
    }
    console.log(JSON.stringify([...scores.keys()].sort((a,b) => scores.get(b) - scores.get(a))))
  } else console.log('[]')
} finally {
  await unloadModels()
}
