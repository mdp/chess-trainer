import type { GameSummary, Phase } from './gameData'

export type DecisionPoint = {
  gameId: string
  ply: number
  fen: string
  phase: Phase
  score: number
  previousMove: string | null
}

type DecisionPointIndex = {
  version: number
  sourceGames: number
  engine: string
  positions: DecisionPoint[]
}

/** Load the precomputed game index without replaying thousands of PGNs in-browser. */
export async function loadGameCorpus(baseUrl: string): Promise<GameSummary[]> {
  const response = await fetch(`${baseUrl}data/games.json`)
  if (!response.ok) throw new Error(`Unable to load game corpus (${response.status})`)
  const records = await response.json() as GameSummary[]
  if (!Array.isArray(records) || records.some((game) => !game.id || !game.white || !game.black)) {
    throw new Error('Invalid precomputed game corpus')
  }
  return records
}

export async function loadDecisionPoints(baseUrl: string): Promise<DecisionPoint[]> {
  const response = await fetch(`${baseUrl}data/decision-points.json`)
  if (!response.ok) throw new Error(`Unable to load decision-point index (${response.status})`)
  const index = await response.json() as DecisionPointIndex
  if (index.version !== 1 || !Array.isArray(index.positions)) throw new Error('Unsupported decision-point index')
  return index.positions
}

/**
 * Prefer a random position from the high-interestingness band, not the first
 * position matching a broad phase label. Exclude the just-played game when
 * there are alternatives; callers can fall back to the classic selector.
 */
export function chooseDecisionPoint(
  games: GameSummary[],
  points: DecisionPoint[],
  excludeGameId?: string | null,
): { game: GameSummary; point: DecisionPoint; index: number } | null {
  if (!games.length || !points.length) return null
  const gamesById = new Map(games.map((game, index) => [game.id, { game, index }]))
  let candidates = points.flatMap((point) => {
    const match = gamesById.get(point.gameId)
    return match && point.ply >= 0 && Boolean(point.fen)
      ? [{ ...match, point }]
      : []
  })
  if (excludeGameId && candidates.some((candidate) => candidate.game.id !== excludeGameId)) {
    candidates = candidates.filter((candidate) => candidate.game.id !== excludeGameId)
  }
  if (!candidates.length) return null

  const phaseWeights: Record<Phase, number> = { opening: 0.2, middlegame: 0.55, endgame: 0.25 }
  const phases = [...new Set(candidates.map(({ point }) => point.phase))]
  const totalWeight = phases.reduce((sum, phase) => sum + phaseWeights[phase], 0)
  let phaseRoll = Math.random() * totalWeight
  let chosenPhase = phases[0]
  for (const phase of phases) {
    phaseRoll -= phaseWeights[phase]
    if (phaseRoll < 0) {
      chosenPhase = phase
      break
    }
  }
  const phaseCandidates = candidates.filter(({ point }) => point.phase === chosenPhase)
  const qualityBandSize = Math.max(1, Math.ceil(phaseCandidates.length * 0.3))
  const orderedScores = phaseCandidates.map(({ point }) => point.score).sort((left, right) => right - left)
  const threshold = orderedScores[qualityBandSize - 1]
  // Include the full cutoff score tier so ties don't systematically favor the
  // earliest games in the corpus just because the source index is ordered.
  const qualityBand = phaseCandidates.filter(({ point }) => point.score >= threshold)
  const chosen = qualityBand[Math.floor(Math.random() * qualityBand.length)]
  return { ...chosen, point: chosen.point }
}
