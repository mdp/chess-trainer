import type { MoveFeedback } from './types'

export interface EngineAnalysisLine {
  move: string
  scoreCp?: number
  mateIn?: number
  pv?: string[]
}

export interface EngineAnalysis {
  fen: string
  lines: EngineAnalysisLine[]
}

export interface EngineAdapter {
  analyzePosition(fen: string, options?: {
    depth?: number
    multipv?: number
    maxTimeMs?: number
  }): Promise<EngineAnalysis>
}

export type EngineWorkerRequest =
  | { type: 'init'; moduleUrl: string; networkUrl?: string }
  | { type: 'analyze'; id: number; fen: string; depth: number; multipv: number; maxTimeMs?: number }
  | { type: 'stop' }

export type EngineWorkerResponse =
  | { type: 'ready' }
  | { type: 'analysis'; id: number; analysis: EngineAnalysis }
  | { type: 'error'; id?: number; message: string }

export type WorkerFactory = () => Worker

/** Development fallback used until the WASM files are copied into public/engine. */
export class DemoEngineAdapter implements EngineAdapter {
  async analyzePosition(fen: string): Promise<EngineAnalysis> {
    return { fen, lines: [] }
  }
}

export class WasmEngineAdapter implements EngineAdapter {
  private readonly worker: Worker
  private nextId = 1
  private ready: Promise<void>
  private pending = new Map<number, { resolve: (analysis: EngineAnalysis) => void; reject: (error: Error) => void }>()

  constructor(options: { moduleUrl?: string; networkUrl?: string; workerFactory?: WorkerFactory } = {}) {
    this.worker = options.workerFactory?.() ?? new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'classic' })
    this.ready = new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent<EngineWorkerResponse>) => {
        const message = event.data
        if (message.type === 'ready') resolve()
        if (message.type === 'error' && message.id === undefined) reject(new Error(message.message))
        this.handle(message)
      }
      this.worker.addEventListener('message', onMessage)
      this.worker.addEventListener('error', () => reject(new Error('The chess engine worker failed to start.')))
    })
    this.worker.postMessage({
      type: 'init',
      moduleUrl: options.moduleUrl ?? '/engine/berserk.js',
      networkUrl: options.networkUrl ?? '/engine/berserk-9b84c340af7e.nn',
    } satisfies EngineWorkerRequest)
  }

  analyzePosition(fen: string, options: { depth?: number; multipv?: number; maxTimeMs?: number } = {}) {
    const id = this.nextId++
    return this.ready.then(() => new Promise<EngineAnalysis>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({
        type: 'analyze', id, fen,
        depth: options.depth ?? 14,
        multipv: options.multipv ?? 4,
        maxTimeMs: options.maxTimeMs,
      } satisfies EngineWorkerRequest)
    }))
  }

  stop() { this.worker.postMessage({ type: 'stop' } satisfies EngineWorkerRequest) }

  dispose() { this.worker.terminate(); for (const request of this.pending.values()) request.reject(new Error('Engine disposed')) }

  private handle(message: EngineWorkerResponse) {
    if (message.type === 'analysis') {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      request.resolve(message.analysis)
    }
    if (message.type === 'error' && message.id !== undefined) {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      request.reject(new Error(message.message))
    }
  }
}

export function createEngineAdapter(): EngineAdapter {
  const baseUrl = import.meta.env.BASE_URL
  return new WasmEngineAdapter({
    moduleUrl: import.meta.env.VITE_ENGINE_MODULE_URL ?? `${baseUrl}engine/berserk.js`,
    networkUrl: import.meta.env.VITE_ENGINE_NETWORK_URL ?? `${baseUrl}engine/berserk-9b84c340af7e.nn`,
  })
}

export function classifyEngineMove(move: string, san: string, analysis: EngineAnalysis, fallback: string[]): MoveFeedback {
  const lines = analysis.lines.length ? analysis.lines : fallback.map((candidate) => ({ move: candidate }))
  const index = lines.findIndex((line) => line.move === move)
  const isTopChoice = index === 0
  const isCloseAlternative = index >= 0 && index < Math.min(lines.length, 4)
  const label = isTopChoice ? 'Excellent' : isCloseAlternative ? 'Good' : 'Playable'
  const ideas = isCloseAlternative
    ? ['improves a piece', 'keeps the center in view', 'supports king safety']
    : ['keeps the position playable', 'does not solve the most urgent problem yet']

  return {
    label,
    title: isCloseAlternative ? `${san} fits the position` : `${san} is playable, but there is more to do`,
    body: isTopChoice
      ? 'The engine agrees with your plan, and the move improves the position immediately.'
      : isCloseAlternative
        ? 'The engine slightly prefers another move, but your choice is a practical way to pursue the position’s ideas.'
        : 'Look first for a move that develops, improves king safety, or creates useful central pressure.',
    ideas,
    move: san,
  }
}

export function classifyDemoMove(move: string, san: string, suggestions: string[]): MoveFeedback {
  const isSuggested = suggestions.includes(move)
  const label = isSuggested ? 'Excellent' : 'Playable'
  const ideas = isSuggested
    ? ['improves a piece', 'keeps the center in view', 'supports king safety']
    : ['is legal and keeps the position playable', 'does not solve an urgent problem yet']

  return {
    label,
    title: isSuggested ? `${san} fits the position` : `${san} is playable, but there is more to do`,
    body: isSuggested
      ? 'This move follows the position’s demands instead of chasing a memorized line.'
      : 'Look first for a move that develops, improves king safety, or creates useful central pressure.',
    ideas,
    move: san,
  }
}
