import { Chess } from 'chess.js'

export function describePosition(fen: string): string[] {
  const chess = new Chess(fen)
  const board = chess.board()
  const ideas: string[] = []
  let undeveloped = 0

  for (const [square, expected] of [['b1', 'n'], ['g1', 'n'], ['c1', 'b'], ['f1', 'b']] as const) {
    if (chess.get(square as never)?.type === expected) undeveloped += 1
  }
  if (undeveloped > 0) ideas.push(`${undeveloped} minor piece${undeveloped === 1 ? '' : 's'} still need development`)
  const centralPieces = ['d4', 'e4', 'd5', 'e5'].some((square) => chess.get(square as never))
  if (centralPieces) ideas.push('the central squares are already part of the conversation')
  if (chess.isCheckmate()) ideas.push('there is a forcing tactical priority')
  return ideas
}
