/// <reference lib="webworker" />

import type { EngineAnalysisLine, EngineWorkerRequest, EngineWorkerResponse } from './engineAdapter'

type EmscriptenModule = {
  ccall: (name: string, returnType: string | null, argumentTypes: string[], args: unknown[], options?: { async?: boolean }) => unknown
  FS?: { mkdir: (path: string) => void; writeFile: (path: string, data: Uint8Array) => void }
  print?: (line: string) => void
}

declare const self: DedicatedWorkerGlobalScope
let module: EmscriptenModule | null = null
let currentLines = new Map<number, EngineAnalysisLine>()
let currentRequest: { id: number; fen: string } | null = null

self.onmessage = async (event: MessageEvent<EngineWorkerRequest>) => {
  try {
    if (event.data.type === 'init') await initialize(event.data.moduleUrl, event.data.networkUrl)
    if (event.data.type === 'analyze') await analyze(event.data)
    if (event.data.type === 'stop') call('berserk_command', ['stop'])
  } catch (error) {
    respond({ type: 'error', id: event.data.type === 'analyze' ? event.data.id : undefined, message: error instanceof Error ? error.message : String(error) })
  }
}

async function initialize(moduleUrl: string, networkUrl?: string) {
  self.importScripts(moduleUrl)
  const factory = (self as DedicatedWorkerGlobalScope & { BerserkModule?: (options: Record<string, unknown>) => Promise<EmscriptenModule> }).BerserkModule
  if (!factory) throw new Error('Berserk module did not load')
  module = await factory({
    locateFile: (file: string) => file.endsWith('.wasm') ? moduleUrl.replace(/\.js$/, '.wasm') : file,
    print: (line: string) => consume(line),
    printErr: (line: string) => console.warn('[berserk]', line),
  })
  if (networkUrl && module.FS) {
    try { module.FS.mkdir('/net') } catch { /* MEMFS directory may already exist */ }
    const response = await fetch(networkUrl)
    if (!response.ok) throw new Error(`Unable to fetch NNUE network (${response.status})`)
    module.FS.writeFile('/net/berserk.nn', new Uint8Array(await response.arrayBuffer()))
  }
  const initialized = call('berserk_init', [])
  if (!initialized) throw new Error('Berserk failed to initialize')
  respond({ type: 'ready' })
}

async function analyze(request: Extract<EngineWorkerRequest, { type: 'analyze' }>) {
  if (!module) throw new Error('Engine is not initialized')
  currentRequest = { id: request.id, fen: request.fen }
  currentLines = new Map()
  call('berserk_command', [`setoption name MultiPV value ${request.multipv}`])
  call('berserk_command', [`position fen ${request.fen}`])
  await Promise.resolve(call('berserk_command', [request.maxTimeMs ? `go depth ${request.depth} movetime ${request.maxTimeMs}` : `go depth ${request.depth}`], true))
  if (currentRequest?.id !== request.id) return
  respond({ type: 'analysis', id: request.id, analysis: { fen: request.fen, lines: [...currentLines.values()] } })
  currentRequest = null
}

function call(name: string, args: string[], async = false) {
  if (!module) throw new Error('Engine is not initialized')
  return module.ccall(name, 'number', ['string'], args, async ? { async: true } : undefined)
}

function consume(line: string) {
  if (line.startsWith('info ')) parseInfo(line)
  if (line.startsWith('bestmove ') && currentRequest) {
    postMessage({ type: 'analysis', id: currentRequest.id, analysis: { fen: currentRequest.fen, lines: [...currentLines.values()] } } satisfies EngineWorkerResponse)
    currentRequest = null
  }
}

function parseInfo(line: string) {
  if (!currentRequest || !line.includes(' score ')) return
  const multipv = Number(line.match(/\bmultipv (\d+)/)?.[1] ?? 1)
  const cp = line.match(/\bscore cp (-?\d+)/)
  const mate = line.match(/\bscore mate (-?\d+)/)
  const pv = line.match(/\bpv (.+)$/)?.[1]?.split(' ')
  const move = pv?.[0]
  if (!move) return
  currentLines.set(multipv, { move, scoreCp: cp ? Number(cp[1]) : undefined, mateIn: mate ? Number(mate[1]) : undefined, pv })
}

function respond(message: EngineWorkerResponse) { postMessage(message) }
