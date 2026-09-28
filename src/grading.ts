import type { MoveGrade } from './types'

/** Logistic centipawn-to-expected-score curve (draws count as half a win). */
export function expectedScore(cp: number): number {
  const bounded = Math.max(-10_000, Math.min(10_000, cp))
  return 1 / (1 + Math.exp(-bounded / 280))
}

export function expectedScoreFromMate(mateIn: number): number {
  if (mateIn === 0) return 0.5
  return expectedScore(mateIn > 0 ? 10_000 : -10_000)
}

export function scoreValue(cp?: number, mateIn?: number): number {
  if (mateIn !== undefined) return expectedScoreFromMate(mateIn)
  return expectedScore(cp ?? 0)
}

export function gradeWdlLoss(loss: number): MoveGrade {
  if (loss < 0.04) return 'Excellent'
  if (loss < 0.10) return 'Good'
  if (loss < 0.20) return 'Inaccuracy'
  if (loss < 0.35) return 'Mistake'
  return 'Blunder'
}

/**
 * Keep expected-score grading from hiding large raw evaluation drops when a
 * position is already winning or losing and the logistic curve is saturated.
 */
export function gradeWithCpGuard(wdlLoss: number, cpLoss: number | null): MoveGrade {
  const wdlGrade = gradeWdlLoss(wdlLoss)
  if (cpLoss === null) return wdlGrade
  const cpGrade: MoveGrade = cpLoss >= 400 ? 'Blunder'
    : cpLoss >= 200 ? 'Mistake'
      : cpLoss >= 100 ? 'Inaccuracy'
        : 'Excellent'
  const severity: Record<MoveGrade, number> = {
    Excellent: 0,
    Good: 1,
    Inaccuracy: 2,
    Mistake: 3,
    Blunder: 4,
    Unverified: -1,
  }
  return severity[cpGrade] > severity[wdlGrade] ? cpGrade : wdlGrade
}

export function isApprovedGrade(grade: MoveGrade): boolean {
  return grade === 'Excellent' || grade === 'Good' || grade === 'Inaccuracy' || grade === 'Unverified'
}
