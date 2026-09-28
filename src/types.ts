export type MoveGrade = 'Excellent' | 'Good' | 'Inaccuracy' | 'Mistake' | 'Blunder' | 'Unverified'

/** Why a move was approved or not. */
export type PickReason = 'approved' | 'outside-top' | 'negates-advantage' | 'loses-margin' | 'engine-unavailable'

export type PickAttempt = {
  uci: string
  san: string
  grade: MoveGrade
  wdlLoss: number | null
  cpLoss: number | null
}

/** The verdict on one player move, persisted with the game. */
export type Pick = {
  uci: string
  san: string
  approved: boolean
  reason: PickReason
  /** Played move's eval label from the mover's perspective ('+0.4', '−1.2', 'M3'), or null if unverified. */
  cpLabel: string | null
  bestUci: string
  bestSan: string
  bestLabel: string
  grade: MoveGrade
  wdlLoss: number | null
  cpLoss: number | null
  attempts: PickAttempt[]
  revealed?: boolean
}

export type PickAlternative = { san: string; score: string }

export type JudgeFeedback = {
  pick: Pick
  chain: number
  alternatives: PickAlternative[]
  opponentReply?: string
  attemptNo: number
  retrying: boolean
  hintUcis: string[]
}
