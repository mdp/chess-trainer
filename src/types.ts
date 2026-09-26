export type RunFeedback = {
  /** The player's move was one of the engine's top 3. */
  success: boolean
  /** SAN of the played move. */
  played: string
  /** SAN of the engine's best move. */
  best: string
  /** Opponent's reply (SAN). */
  opponentReply?: string
  /** Consecutive top-3 picks after this move. */
  chain: number
  /** Engine's top lines (SAN + score) for display. */
  topMoves: { san: string; score: string }[]
}

export type MoveFeedback = {
  label: 'Excellent' | 'Good' | 'Playable' | 'Inaccuracy'
  title: string
  body: string
  ideas: string[]
  move: string
  /** Opponent's strongest reply, derived from the engine line matching the played move. */
  opponentReply?: string
}
