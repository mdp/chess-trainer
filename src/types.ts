/** Why a move was approved or not. */
export type PickReason = 'approved' | 'outside-top' | 'negates-advantage' | 'loses-margin' | 'engine-unavailable'

/** The verdict on one player move, persisted with the game. */
export type Pick = {
  uci: string
  san: string
  approved: boolean
  reason: PickReason
  /** Played move's eval label from the mover's perspective ('+0.4', '−1.2', 'M3'), or null if unverified. */
  cpLabel: string | null
  bestSan: string
  bestLabel: string
}

export type PickAlternative = { san: string; score: string }

export type JudgeFeedback = {
  pick: Pick
  chain: number
  alternatives: PickAlternative[]
  opponentReply?: string
}
