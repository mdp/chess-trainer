import { Chess, type Square } from 'chess.js'
import gamesPgn from './data/games.pgn?raw'

export type GameHeaders = {
  id: string
  white: string
  black: string
  whiteElo?: number
  blackElo?: number
  eco?: string
  opening?: string
  result: string
  date?: string
}

export type GameRecord = GameHeaders & {
  /** Canonical UCI moves of the full game. */
  moves: string[]
}

/** Splits a PGN bundle into blocks and replays each through chess.js for canonical UCI moves. */
export function parseGames(pgn: string): GameRecord[] {
  return pgn
    .split(/\n\n(?=\[Site )/)
    .flatMap((block) => {
      const chess = new Chess()
      try {
        chess.loadPgn(block)
      } catch {
        return []
      }
      const header = (name: string) => block.match(new RegExp(`\\[${name} "([^"]*)"\\]`))?.[1]
      const site = header('Site') ?? ''
      const id = site.split('/').pop() ?? `${header('White')}-${header('Date')}`
      const moves = chess.history({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ''}`)
      if (!moves.length) return []
      return [{
        id,
        white: header('White') ?? 'White',
        black: header('Black') ?? 'Black',
        whiteElo: header('WhiteElo') ? Number(header('WhiteElo')) : undefined,
        blackElo: header('BlackElo') ? Number(header('BlackElo')) : undefined,
        eco: header('ECO'),
        opening: header('Opening'),
        result: header('Result') ?? '*',
        date: header('Date'),
        moves,
      }]
    })
}

export const gameLibrary = parseGames(gamesPgn)

export type Phase = 'opening' | 'middlegame' | 'endgame'

/** Rough phase tag from piece count (non-pawn pieces besides kings). */
export function phaseAt(chess: Chess): Phase {
  const fullmove = Number(chess.fen().split(' ')[5])
  let pieces = 0
  let pawns = 0
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue
      if (piece.type === 'k') continue
      if (piece.type === 'p') pawns += 1
      else pieces += 1
    }
  }
  if (fullmove <= 10 && pieces >= 10) return 'opening'
  if (pieces <= 6) return 'endgame'
  return 'middlegame'
}

export function fenAfterMoves(moves: string[], upTo: number): string {
  const chess = new Chess()
  for (const uci of moves.slice(0, upTo)) {
    chess.move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      ...(uci[4] ? { promotion: uci[4] as 'q' | 'r' | 'b' | 'n' } : {}),
    })
  }
  return chess.fen()
}

export function sanFor(fen: string, uci: string): string | undefined {
  try {
    const chess = new Chess(fen)
    return chess.move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      ...(uci[4] ? { promotion: uci[4] as 'q' | 'r' | 'b' | 'n' } : {}),
    })?.san
  } catch { return undefined }
}

/** First ply where the phase matches the wish; falls back to a sensible default. */
export function startPlyForPhase(game: GameRecord, wish: Phase): number {
  const chess = new Chess()
  let fallback: number | null = null
  for (let ply = 0; ply < game.moves.length; ply += 1) {
    const uci = game.moves[ply]
    chess.move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      ...(uci[4] ? { promotion: uci[4] as 'q' | 'r' | 'b' | 'n' } : {}),
    })
    const phase = phaseAt(chess)
    if (phase === wish && ply >= 4) {
      // Keep a few of the opening moves so the position still feels "from a game".
      return Math.min(ply + 1, game.moves.length - 2)
    }
    if (phase === 'middlegame' && fallback === null && ply >= 10) fallback = Math.min(ply + 1, game.moves.length - 2)
  }
  // No explicit endgame phase found: start late, where material has thinned out.
  const lateFallback = Math.max(12, game.moves.length - Math.min(24, Math.floor(game.moves.length / 3)))
  if (wish === 'endgame') return Math.min(lateFallback, game.moves.length - 2)
  return fallback ?? Math.min(lateFallback, game.moves.length - 2)
}

/** The mix the trainer serves: mostly middlegames, some openings, occasional endgames. */
const PHASE_PATTERN: Phase[] = [
  'middlegame', 'opening', 'middlegame', 'endgame',
  'middlegame', 'middlegame', 'opening', 'middlegame',
  'endgame', 'middlegame', 'opening', 'middlegame',
]

export function nextGame(library: GameRecord[], cursor: number, excludeId?: string | null): { game: GameRecord; startPly: number; phase: Phase; index: number } {
  for (let attempt = 0; attempt < library.length; attempt += 1) {
    const index = (cursor + attempt) % library.length
    const game = library[index]
    if (game.id === excludeId && library.length > 1) continue
    const phase = PHASE_PATTERN[cursor % PHASE_PATTERN.length]
    return { game, startPly: startPlyForPhase(game, phase), phase, index }
  }
  const game = library[0]
  return { game, startPly: startPlyForPhase(game, 'middlegame'), phase: 'middlegame', index: 0 }
}

/** First index where the played line leaves the recorded game, or null while still on it. */
export function divergenceIndex(played: string[], record: string[]): number | null {
  for (let index = 0; index < played.length; index += 1) {
    if (played[index] !== record[index]) return index
  }
  return null
}