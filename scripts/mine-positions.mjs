// Offline decision-point mining using the same Berserk WASM + NNUE engine as
// the app. The checked-in output is served as a static asset, not JS bundle data.
//
// Usage: bun scripts/mine-positions.mjs [games.pgn] [decision-points.json] [positionsPerGame] [thinkMs] [gameLimit] [phase] [append] [minScore]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Chess } from 'chess.js'
import { recordsFromPgn } from './pgnRecords.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const corpusPath = resolve(process.argv[2] ?? join(root, 'data/games.pgn'))
const outputPath = resolve(process.argv[3] ?? join(root, 'public/data/decision-points.json'))
const positionsPerGame = Math.max(1, Number(process.argv[4] ?? 2))
const thinkMs = Math.max(20, Number(process.argv[5] ?? 70))
const gameLimit = Number(process.argv[6] ?? 0)
const targetPhase = process.argv[7] ?? 'all'
const append = process.argv[8] === 'append'
const minScore = Number(process.argv[9] ?? 0)
if (!['all', 'opening', 'middlegame', 'endgame'].includes(targetPhase)) throw new Error(`Unknown phase: ${targetPhase}`)
const engineDir = '/tmp/opencode/chess-trainer-engine'
const engineCjs = `${engineDir}/berserk.cjs`

mkdirSync(engineDir, { recursive: true })
copyFileSync(join(root, 'public/engine/berserk.js'), engineCjs)
copyFileSync(join(root, 'public/engine/berserk.wasm'), `${engineDir}/berserk.wasm`)
const createModule = createRequire(import.meta.url)(engineCjs)

const currentLines = new Map()
let onBestMove = null
const engineModule = await createModule({
  locateFile: () => `${engineDir}/berserk.wasm`,
  print: consume,
  printErr: (line) => console.warn('[berserk]', line),
})
engineModule.FS.mkdir('/net')
engineModule.FS.writeFile('/net/berserk.nn', new Uint8Array(readFileSync(join(root, 'public/engine/berserk-9b84c340af7e.nn'))))
if (!engineModule.ccall('berserk_init', 'number', [], [])) throw new Error('Berserk failed to initialize')

function consume(line) {
  if (line.startsWith('info ')) {
    if (!line.includes(' score ') || /\b(?:lowerbound|upperbound)\b/.test(line)) return
    const rank = Number(line.match(/\bmultipv (\d+)/)?.[1] ?? 1)
    const cp = line.match(/\bscore cp (-?\d+)/)
    const mate = line.match(/\bscore mate (-?\d+)/)
    const pv = line.match(/\bpv (.+)$/)?.[1]?.trim().split(/\s+/)
    if (pv?.[0]) currentLines.set(rank, { move: pv[0], pv, scoreCp: cp ? Number(cp[1]) : undefined, mateIn: mate ? Number(mate[1]) : undefined })
  }
  if (line.startsWith('bestmove ') && onBestMove) {
    const done = onBestMove
    onBestMove = null
    done([...currentLines.entries()].sort(([a], [b]) => a - b).map(([, value]) => value))
  }
}

async function analyze(fen) {
  currentLines.clear()
  engineModule.ccall('berserk_command', 'number', ['string'], ['setoption name MultiPV value 3'])
  engineModule.ccall('berserk_command', 'number', ['string'], [`position fen ${fen}`])
  let finishSearch
  const result = new Promise((resolveResult) => { finishSearch = resolveResult })
  onBestMove = finishSearch
  const search = engineModule.ccall('berserk_command', 'number', ['string'], [`go depth 10 movetime ${thinkMs}`], { async: true })
  const timeoutMs = Math.max(5000, thinkMs * 20)
  let timer
  const timeout = new Promise((resolveResult) => { timer = setTimeout(() => resolveResult(null), timeoutMs) })
  const lines = await Promise.race([result, timeout])
  clearTimeout(timer)
  if (lines === null) {
    console.warn(`  search exceeded ${timeoutMs}ms; stopping and skipping this position`)
    engineModule.ccall('berserk_command', 'number', ['string'], ['stop'])
    const stopped = await Promise.race([
      result,
      new Promise((resolveResult) => setTimeout(() => resolveResult(null), 3000)),
    ])
    if (stopped === null) throw new Error(`Berserk did not stop a search within ${timeoutMs}ms`)
    await Promise.race([search, new Promise((resolveResult) => setTimeout(resolveResult, 1000))])
    return []
  }
  await search
  return lines
}

function evalValue(line) {
  if (line.mateIn !== undefined) return line.mateIn > 0 ? 100_000 - line.mateIn : -100_000 + Math.abs(line.mateIn)
  return line.scoreCp ?? 0
}

function phaseAt(chess) {
  const fullmove = Number(chess.fen().split(' ')[5])
  let pieces = 0
  for (const row of chess.board()) for (const piece of row) {
    if (piece && piece.type !== 'k' && piece.type !== 'p') pieces += 1
  }
  if (fullmove <= 10 && pieces >= 10) return 'opening'
  if (pieces <= 6) return 'endgame'
  return 'middlegame'
}

function stringHash(value) {
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

function candidatePlies(game, count, phase) {
  const min = Math.min(8, Math.max(0, game.moves.length - 3))
  const max = Math.max(min, game.moves.length - 3)
  const hash = stringHash(game.id)
  if (phase === 'opening') {
    // Sample a real early-game decision, within the app's opening heuristic.
    return [Math.max(0, Math.min(game.moves.length - 3, 8 + hash % 11))]
  }
  return Array.from({ length: count }, (_, index) => {
    const fraction = count === 1 ? 0.53 : 0.28 + (0.56 * (index + 0.5) / count)
    const jitter = ((hash >>> (index * 5 % 24)) & 31) / 1000 - 0.015
    return Math.max(min, Math.min(max, Math.floor(game.moves.length * (fraction + jitter))))
  }).filter((ply, index, all) => all.indexOf(ply) === index)
}

function fenAt(game, ply) {
  const chess = new Chess()
  for (const move of game.moves.slice(0, ply)) {
    chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), ...(move[4] ? { promotion: move[4] } : {}) })
  }
  return chess.fen()
}

const corpusText = readFileSync(corpusPath, 'utf8')
const allGames = corpusPath.endsWith('.json') ? JSON.parse(corpusText) : recordsFromPgn(corpusText)
const games = gameLimit > 0 ? allGames.slice(0, gameLimit) : allGames
const positions = []
const startedAt = Date.now()
const candidateCount = targetPhase === 'opening' ? 1 : positionsPerGame
console.log(`Mining ${candidateCount} ${targetPhase} candidate position${candidateCount === 1 ? '' : 's'} in ${games.length} games (depth 10 / ${thinkMs} ms per search)`)

for (let gameIndex = 0; gameIndex < games.length; gameIndex += 1) {
  const game = games[gameIndex]
  const plies = candidatePlies(game, candidateCount, targetPhase)
  for (const ply of plies) {
    const fen = fenAt(game, ply)
    const chess = new Chess(fen)
    if (targetPhase !== 'all' && phaseAt(chess) !== targetPhase) continue
    const moveLines = await analyze(fen)
    if (moveLines.length < 2) continue
    const best = moveLines[0]
    const second = moveLines[1]
    const bestVal = evalValue(best)
    const gapCp = Math.max(0, Math.min(2000, bestVal - evalValue(second)))
    const playedMove = game.moves[ply]
    const played = moveLines.find((line) => line.move === playedMove)
    const playedLossCp = played ? Math.max(0, Math.min(2000, bestVal - evalValue(played))) : null
    let bestSan = best.move
    try { bestSan = chess.move({ from: best.move.slice(0, 2), to: best.move.slice(2, 4), ...(best.move[4] ? { promotion: best.move[4] } : {}) }).san } catch { /* retain UCI */ }
    const themes = []
    if (gapCp >= 100) themes.push('only-move')
    if (/[x+#]/.test(bestSan) || best.mateIn !== undefined) themes.push('tactical')
    if (playedLossCp !== null && playedLossCp >= 100) themes.push('game-mistake')
    // Reward a clear best move, tactical forcing moves, and a consequential
    // departure in the recorded game. Keep every analyzed position for later
    // tuning; the client chooses from the most instructive upper quantile.
    const score = Math.round(Math.min(100, gapCp / 5 + (themes.includes('tactical') ? 15 : 0) + (playedLossCp === null ? 0 : Math.min(20, playedLossCp / 10))))
    positions.push({
      gameId: game.id,
      ply,
      fen,
      previousMove: game.moves[ply - 1] ?? null,
      phase: phaseAt(chess),
      score,
      gapCp,
      bestMove: best.move,
      bestSan,
      bestEvalCp: best.scoreCp ?? null,
      mateIn: best.mateIn ?? null,
      alternatives: moveLines.slice(0, 3).map((line) => ({ move: line.move, scoreCp: line.scoreCp ?? null, mateIn: line.mateIn ?? null })),
      playedMove,
      playedRank: played ? moveLines.indexOf(played) + 1 : null,
      playedLossCp,
      themes,
    })
  }
  if ((gameIndex + 1) % 100 === 0 || gameIndex + 1 === games.length) {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`  ${gameIndex + 1}/${games.length} games · ${positions.length} positions · ${seconds}s`)
  }
}

mkdirSync(dirname(outputPath), { recursive: true })
const additions = minScore > 0 ? positions.filter((point) => point.score >= minScore) : positions
let finalPositions = additions
if (append) {
  let previous = []
  try { previous = JSON.parse(readFileSync(outputPath, 'utf8')).positions ?? [] } catch { /* no prior index to append */ }
  const byKey = new Map(previous.map((point) => [`${point.gameId}:${point.ply}`, point]))
  for (const point of additions) byKey.set(`${point.gameId}:${point.ply}`, point)
  finalPositions = [...byKey.values()]
}
const runtimePositions = finalPositions.map(({ gameId, ply, fen, previousMove, phase, score }) => ({ gameId, ply, fen, previousMove, phase, score }))
const index = { version: 1, sourceGames: games.length, engine: 'Berserk WASM / bundled NNUE, depth 10', generatedAt: new Date().toISOString(), positions: runtimePositions }
writeFileSync(outputPath, JSON.stringify(index))
console.log(`Wrote ${positions.length} analyzed; added ${additions.length} (${runtimePositions.length} total) runtime positions to ${outputPath} (${(Buffer.byteLength(JSON.stringify(runtimePositions)) / 1024 / 1024).toFixed(2)} MiB)`)
