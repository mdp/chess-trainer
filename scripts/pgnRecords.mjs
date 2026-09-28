import { Chess } from 'chess.js'

/** Parse one PGN game and precompute its canonical UCI move list. */
export function recordFromPgnBlock(block) {
  const headers = Object.fromEntries(
    [...block.matchAll(/^\[(\w+) "([^"]*)"\]$/gm)].map(([, key, value]) => [key, value]),
  )
  const chess = new Chess()
  try { chess.loadPgn(block) } catch { return null }
  const moves = chess.history({ verbose: true })
    .map((move) => `${move.from}${move.to}${move.promotion ?? ''}`)
  if (!moves.length) return null
  const siteId = headers.Site?.split('/').pop()
  const whiteElo = Number(headers.WhiteElo)
  const blackElo = Number(headers.BlackElo)
  return {
    id: siteId || `${headers.White ?? 'White'}-${headers.Date ?? 'unknown'}`,
    white: headers.White ?? 'White',
    black: headers.Black ?? 'Black',
    ...(Number.isFinite(whiteElo) && whiteElo > 0 ? { whiteElo } : {}),
    ...(Number.isFinite(blackElo) && blackElo > 0 ? { blackElo } : {}),
    ...(headers.ECO ? { eco: headers.ECO } : {}),
    ...(headers.Opening ? { opening: headers.Opening } : {}),
    result: headers.Result ?? '*',
    ...(headers.Date ? { date: headers.Date } : {}),
    moves,
  }
}

/** Parse a PGN bundle into compact game records with precomputed UCI moves. */
export function recordsFromPgn(pgn) {
  return pgn.split(/\n\n(?=\[Site )/)
    .map(recordFromPgnBlock)
    .filter((record) => record !== null)
}
