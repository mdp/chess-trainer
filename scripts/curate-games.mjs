// Build-time curation of real games from the Lichess open database (CC0).
// Downloads a small prefix of a monthly PGN dump (zstd is partially decompressable),
// filters for decently rated, long-enough rated games, and writes a compact bundle.
//
// Usage: bun scripts/curate-games.mjs [month] [targetGames]
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const month = process.argv[2] ?? '2026-08'
const target = Number(process.argv[3] ?? 260)
const url = `https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`
const work = '/tmp/opencode/lichess-games'
const outPath = new URL('../src/data/games.pgn', import.meta.url).pathname

mkdirSync(work, { recursive: true })
const zst = join(work, 'prefix.pgn.zst')
console.log(`downloading prefix of ${url}`)
execFileSync('curl', ['-sL', '-r', '0-40000000', '-o', zst, url], { stdio: 'inherit' })
console.log('decompressing (truncated archive is fine — keep the partial output)')
execFileSync('sh', ['-c', `zstd -dc ${JSON.stringify(zst)} > ${JSON.stringify(join(work, 'prefix.pgn'))} 2>/dev/null || true`])

const raw = readFileSync(join(work, 'prefix.pgn'), 'utf8')
const blocks = raw.split(/\n\n(?=\[Event )/)
console.log(`prefix contains ${blocks.length} games`)

const KEEP_TAGS = ['Site', 'Date', 'White', 'Black', 'Result', 'WhiteElo', 'BlackElo', 'ECO', 'Opening', 'TimeControl', 'Termination']
const minElo = 1900
const minPlies = 60

const kept = []
for (const block of blocks) {
  const tag = (name) => block.match(new RegExp(`\\[${name} "([^"]*)"\\]`))?.[1]
  if (tag('Variant') && tag('Variant') !== 'Standard') continue
  const termination = tag('Termination')
  if (termination && termination !== 'Normal') continue
  const whiteElo = Number(tag('WhiteElo') ?? 0)
  const blackElo = Number(tag('BlackElo') ?? 0)
  if (!whiteElo || !blackElo || Math.min(whiteElo, blackElo) < minElo) continue
  const moves = block.split(/\n\n/).slice(1).join('\n\n')
    .replace(/\{[^}]*\}/g, '') // strip clock/eval comments
    .replace(/\s+/g, ' ')
    .trim()
  const plies = moves.split(' ').filter((token) => !/^\d+\.(\.\.)?$/.test(token) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)).length
  if (plies < minPlies) continue
  const headers = KEEP_TAGS.map((name) => `[${name} "${tag(name) ?? '?'}"]`).join('\n')
  // renumber movetext compactly: "e4 e5 Nf3 ..." keeps SAN tokens only
  const san = moves.split(' ').filter((token) => !/^\d+\.(\.\.)?$/.test(token) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)).join(' ')
  kept.push(`${headers}\n\n${san} ${tag('Result') ?? '*'}\n`)
  if (kept.length >= target) break
}

console.log(`kept ${kept.length} games (min Elo ${minElo}, min plies ${minPlies})`)
writeFileSync(outPath, kept.join('\n'))
console.log(`wrote ${outPath} (${(kept.join('').length / 1024).toFixed(0)} kB)`)
