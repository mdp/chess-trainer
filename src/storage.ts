import type { Phase } from './gameData'

export type Streak = { current: number; longest: number; lastDay: string | null }

export type Settings = { /** Berserk think time per move, ms. */ engineTimeMs: number }

export type RunStats = {
  /** Completed games (reached the 3-in-a-row goal, played to the end, or moved on). */
  gamesPlayed: number
  /** Times the 3-in-a-row goal was achieved. */
  runsAchieved: number
  /** Longest chain of consecutive top-3 picks, ever. */
  bestRun: number
}

export type Profile = {
  id: string
  name: string
  createdAt: string
  streak: Streak
  settings: Settings
  stats: RunStats
  /** Cached PGN of synced Lichess games for this profile. */
  syncedPgn?: string
  /** Cursor into the game library for the next game. */
  cursor: number
  /** Exactly where the player left off: the game, the line, and the run state. */
  session: {
    gameId: string
    startPly: number
    phase: Phase
    line: string[]
    movesUci: string[]
    lineIndex: number
    /** Judgement (top-3 or not) of each player move in order. */
    picks: boolean[]
    done: boolean
  } | null
}

export type Store = {
  activeProfileId: string | null
  profiles: Profile[]
}

const STORAGE_KEY = 'chess-trainer:store:v1'

export function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Store
      if (parsed && Array.isArray(parsed.profiles)) return parsed
    }
  } catch { /* corrupted or unavailable storage: start fresh */ }
  return { activeProfileId: null, profiles: [] }
}

export function saveStore(store: Store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch { /* storage full or blocked: training still works this session */ }
}

export function createProfile(name: string): Profile {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `p-${Date.now()}`
  return {
    id,
    name: name.trim() || 'Player',
    createdAt: new Date().toISOString(),
    streak: { current: 0, longest: 0, lastDay: null },
    settings: { engineTimeMs: 2000 },
    stats: { gamesPlayed: 0, runsAchieved: 0, bestRun: 0 },
    cursor: 0,
    session: null,
  }
}

function today(): string {
  return new Date().toLocaleDateString('en-CA')
}

function daysBetween(from: string, to: string): number | null {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return Math.round((end - start) / 86_400_000)
}

function advanceStreak(streak: Streak): Streak {
  const day = today()
  if (streak.lastDay === day) return streak
  const gap = streak.lastDay ? daysBetween(streak.lastDay, day) : null
  const current = gap === 1 ? streak.current + 1 : 1
  return { current, longest: Math.max(streak.longest, current), lastDay: day }
}

/** The day-streak advances on real training milestones (a run achieved or a game finished). */
export function noteMilestone(profile: Profile, achieved: boolean, chain: number): Profile {
  const advanced = advanceStreak(profile.streak)
  return {
    ...profile,
    streak: advanced,
    stats: {
      gamesPlayed: profile.stats.gamesPlayed,
      runsAchieved: profile.stats.runsAchieved + (achieved ? 1 : 0),
      bestRun: Math.max(profile.stats.bestRun, chain),
    },
  }
}

/** Marks a game as finished (or moved on from) and advances the streak. */
export function noteGameFinished(profile: Profile, bestChainInGame: number): Profile {
  return {
    ...profile,
    streak: advanceStreak(profile.streak),
    stats: {
      gamesPlayed: profile.stats.gamesPlayed + 1,
      runsAchieved: profile.stats.runsAchieved,
      bestRun: Math.max(profile.stats.bestRun, bestChainInGame),
    },
  }
}
