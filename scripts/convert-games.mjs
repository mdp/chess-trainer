// One-time conversion for an existing curated PGN bundle: emit runtime-only
// game metadata and attach the preceding recorded move to mined positions.
// Usage: bun scripts/convert-games.mjs [games.pgn] [games.json] [decision-points.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordsFromPgn } from './pgnRecords.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = resolve(process.argv[2] ?? resolve(root, 'data/games.pgn'))
const outputPath = resolve(process.argv[3] ?? resolve(root, 'public/data/games.json'))
const pointsPath = resolve(process.argv[4] ?? resolve(root, 'public/data/decision-points.json'))
const records = recordsFromPgn(readFileSync(inputPath, 'utf8'))
if (!records.length) throw new Error(`No games parsed from ${inputPath}`)
const summaries = records.map(({ id, white, black, eco, opening }) => ({ id, white, black, ...(eco ? { eco } : {}), ...(opening ? { opening } : {}) }))
writeFileSync(outputPath, JSON.stringify(summaries))
try {
  const index = JSON.parse(readFileSync(pointsPath, 'utf8'))
  const movesByGame = new Map(records.map((game) => [game.id, game.moves]))
  index.positions = (index.positions ?? []).map((point) => ({
    gameId: point.gameId,
    ply: point.ply,
    fen: point.fen,
    previousMove: movesByGame.get(point.gameId)?.[point.ply - 1] ?? null,
    phase: point.phase,
    score: point.score,
  }))
  writeFileSync(pointsPath, JSON.stringify(index))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
console.log(`Converted ${records.length} games to ${outputPath} (${(Buffer.byteLength(JSON.stringify(summaries)) / 1024).toFixed(0)} kB metadata only)`)
