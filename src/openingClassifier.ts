import { Chess } from 'chess.js'
import openingTsv from './data/openings.tsv?raw'
import { openingFamilies } from './openingFamilies'
import type { Exercise, OpeningContext } from './types'

type OpeningRecord = { eco: string; name: string; moves: string[] }

function parseOpeningRecords(): OpeningRecord[] {
  return openingTsv.split(/\r?\n/).slice(1).flatMap((row) => {
    const [eco, name, pgn] = row.split('\t')
    if (!eco || !name || !pgn) return []
    const chess = new Chess()
    const moves: string[] = []
    for (const token of pgn.replace(/\{[^}]*\}/g, '').split(/\s+/)) {
      if (!token || /^\d+\.{1,3}$/.test(token) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) continue
      try {
        const move = chess.move(token)
        moves.push(`${move.from}${move.to}${move.promotion ?? ''}`)
      } catch {
        break
      }
    }
    return moves.length ? [{ eco, name, moves }] : []
  })
}

const openingRecords = parseOpeningRecords()

function startsWithMoves(positionMoves: string[], openingMoves: string[]) {
  return openingMoves.length <= positionMoves.length && openingMoves.every((move, index) => move === positionMoves[index])
}

function familyFor(moves: string[]): OpeningContext {
  const first = moves.slice(0, 2).join(' ')
  if (first === 'e2e4 e7e5' && moves.includes('f1c4')) return openingFamilies.italian
  if (first === 'e2e4 e7e5') return openingFamilies.openGames
  if (first === 'e2e4 c7c5') return openingFamilies.sicilian
  if (first === 'e2e4 e7e6') return openingFamilies.french
  if (first === 'e2e4 c7c6') return openingFamilies.caroKann
  if (first === 'd2d4 d7d5') return openingFamilies.queensPawn
  if (moves[0] === 'c2c4' || moves[0] === 'g1f3') return openingFamilies.hypermodern
  return { familyId: 'unclassified', familyName: 'Opening position', confidence: 'structural', themes: [] }
}

export function classifyOpening(exercise: Pick<Exercise, 'openingMoves' | 'openingContext'>): OpeningContext | undefined {
  if (exercise.openingContext) return exercise.openingContext
  if (!exercise.openingMoves?.length) return undefined
  const exact = openingRecords.filter((record) => startsWithMoves(exercise.openingMoves!, record.moves)).sort((a, b) => b.moves.length - a.moves.length)[0]
  const family = familyFor(exercise.openingMoves)
  if (!exact) return family
  return { ...family, name: exact.name, eco: exact.eco, confidence: 'exact' }
}
