export type Concept = 'development' | 'kingSafety' | 'center' | 'activity'

export type OpeningContext = {
  familyId: string
  familyName: string
  name?: string
  eco?: string
  confidence: 'exact' | 'similar' | 'structural'
  themes: string[]
}

export type Exercise = {
  id: string
  fen: string
  sideToMove: 'white' | 'black'
  title: string
  concepts: Concept[]
  prompt: string
  explanation: string
  suggestedMoves: string[]
  openingMoves?: string[]
  openingContext?: OpeningContext
  /** What the opponent is trying to do in this position. Shown in feedback. */
  opponentPlan?: string
  /** The next thought the player should carry out of the exercise. */
  nextThought?: string
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
