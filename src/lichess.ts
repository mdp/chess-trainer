import { parseGames, type GameRecord } from './gameData'

/**
 * Fetches a player's recent rated games straight from the Lichess API in the
 * browser (lichess.org allows cross-origin requests on this endpoint).
 * No backend involved; the raw PGN is cached locally per profile.
 */
export async function fetchLichessPgn(username: string, options: { max?: number } = {}): Promise<string> {
  const user = encodeURIComponent(username.trim())
  const max = options.max ?? 30
  const params = new URLSearchParams({
    max: String(max),
    moves: 'true',
    opening: 'true',
    clocks: 'false',
    evals: 'false',
    rated: 'true',
  })
  const response = await fetch(`https://lichess.org/api/games/user/${user}?${params}`, {
    headers: { Accept: 'application/x-chess-pgn' },
  })
  if (!response.ok) {
    throw new Error(`Lichess returned ${response.status}${response.status === 404 ? ' — unknown player?' : ''}`)
  }
  const pgn = await response.text()
  if (!parseGames(pgn).length) throw new Error('No usable rated games found for that player')
  return pgn
}

/** Parses cached PGN (bundled or synced) into playable game records. */
export function gamesFromPgn(pgn: string): GameRecord[] {
  return parseGames(pgn)
}
