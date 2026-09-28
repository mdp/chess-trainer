// Build-time curation of real games from the Lichess open database (CC0).
// Downloads a prefix of a monthly PGN dump (zstd is partially decompressable),
// filters for decently rated, long-enough rated games, and writes a static corpus.
//
// Usage: bun scripts/curate-games.mjs [month] [targetGames] [compressedBytes]
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordFromPgnBlock } from './pgnRecords.mjs'

const month = process.argv[2] ?? '2026-08'
const target = Number(process.argv[3] ?? 10_000)
const compressedBytes = Number(process.argv[4] ?? 40_000_000)
const url = `https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`
const work = '/tmp/opencode/lichess-games'
const root = new URL('../', import.meta.url).pathname
const outDir = join(root, 'public/data')
const sourceDir = join(root, 'data')
const outPath = join(outDir, 'games.json')
const sourcePath = join(sourceDir, 'games.pgn')

mkdirSync(work, { recursive: true })
mkdirSync(outDir, { recursive: true })
mkdirSync(sourceDir, { recursive: true })
const zst = join(work, 'prefix.pgn.zst')
console.log(`downloading ${compressedBytes} byte prefix of ${url}`)
execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '-r', `0-${compressedBytes - 1}`, '-o', zst, url], { stdio: 'inherit' })
console.log('decompressing (truncated archive is fine — keep the partial output)')
execFileSync('sh', ['-c', `zstd -dc ${JSON.stringify(zst)} > ${JSON.stringify(join(work, 'prefix.pgn'))} 2>/dev/null || true`])

const raw = readFileSync(join(work, 'prefix.pgn'), 'utf8')
const blocks = raw.split(/\n\n(?=\[Event )/)
console.log(`prefix contains ${blocks.length} games`)

const minElo = 1900
const minPlies = 60

const kept = []
const keptPgn = []
for (const block of blocks) {
  const tag = (name) => block.match(new RegExp(`\\[${name} "([^"]*)"\\]`))?.[1]
  if (tag('Variant') && tag('Variant') !== 'Standard') continue
  const termination = tag('Termination')
  if (termination && termination !== 'Normal') continue
  const whiteElo = Number(tag('WhiteElo') ?? 0)
  const blackElo = Number(tag('BlackElo') ?? 0)
  if (!whiteElo || !blackElo || Math.min(whiteElo, blackElo) < minElo) continue
  const record = recordFromPgnBlock(block)
  if (!record || record.moves.length < minPlies) continue
  kept.push(record)
  keptPgn.push(block.trim())
  if (kept.length >= target) break
}

if (kept.length < target) {
  throw new Error(`Only found ${kept.length}/${target} games; rerun with a larger compressedBytes argument`)
}
console.log(`kept ${kept.length} games (min Elo ${minElo}, min plies ${minPlies})`)
const summaries = kept.map(({ id, white, black, eco, opening }) => ({ id, white, black, ...(eco ? { eco } : {}), ...(opening ? { opening } : {}) }))
writeFileSync(outPath, JSON.stringify(summaries))
writeFileSync(sourcePath, keptPgn.join('\n\n'))
console.log(`wrote ${outPath} (${(Buffer.byteLength(JSON.stringify(summaries)) / 1024).toFixed(0)} kB of game metadata)`)
console.log(`saved offline mining source ${sourcePath} (${(Buffer.byteLength(keptPgn.join('\n\n')) / 1024).toFixed(0)} kB PGN)`)
