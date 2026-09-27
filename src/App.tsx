import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess, type Square } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { createEngineAdapter, type EngineAdapter, type EngineAnalysis, type EngineAnalysisLine } from './engineAdapter'
import { fenAfterMoves, gameLibrary, nextGame, sanFor, type GameRecord, type Phase } from './gameData'
import { fetchLichessPgn, gamesFromPgn } from './lichess'
import { createProfile, loadStore, noteGameFinished, noteMilestone, saveStore, type Profile, type Store } from './storage'
import type { JudgeFeedback, Pick, PickAlternative, PickReason } from './types'

/** Consecutive approved picks needed to complete a game's run. */
const GOAL_CHAIN = 3
/** Quick think time for the engine opponent. */
const OPPONENT_THINK_MS = 600
/** How many engine lines to judge against. */
const JUDGE_MULTIPV = 5
/** Approval margin: played move must be within this many centipawns of the best. */
const MARGIN_CP = 50
const THINK_TIMES = [1000, 2000, 3000, 5000]

type RunState = {
  game: GameRecord
  startPly: number
  phase: Phase
  /** FEN for every ply of the line being played, starting at the run start. */
  line: string[]
  /** UCI move for every ply of the line. */
  movesUci: string[]
  /** Evaluation shown beside each move, from the player's perspective. */
  moveEvalLabels: (string | null)[]
  lineIndex: number
  /** Judgement record for each player move in order. */
  picks: Pick[]
  done: boolean
}

/** Consecutive approved picks at the end of the list. */
function trailingChain(picks: Pick[]): number {
  let count = 0
  for (let index = picks.length - 1; index >= 0 && picks[index].approved; index -= 1) count += 1
  return count
}

/** Longest streak of approved picks anywhere in the list. */
function bestChainIn(picks: Pick[]): number {
  let best = 0
  let current = 0
  for (const pick of picks) {
    current = pick.approved ? current + 1 : 0
    best = Math.max(best, current)
  }
  return best
}

function playerSide(startPly: number): 'w' | 'b' {
  return startPly % 2 === 0 ? 'w' : 'b'
}

/** Eval from the mover's perspective; mates dominate every centipawn score. */
function evalValue(line: EngineAnalysisLine): number {
  if (line.mateIn !== undefined) return line.mateIn > 0 ? 100_000 - line.mateIn : -100_000 + Math.abs(line.mateIn)
  return line.scoreCp ?? 0
}

function fmtEval(line: EngineAnalysisLine | undefined, invert = false): string {
  if (!line) return '—'
  if (line.mateIn !== undefined) {
    const mate = invert ? -line.mateIn : line.mateIn
    return `M${mate > 0 ? '' : '−'}${Math.abs(mate)}`
  }
  if (line.scoreCp === undefined) return '—'
  const score = invert ? -line.scoreCp : line.scoreCp
  return `${score >= 0 ? '+' : '−'}${(Math.abs(score) / 100).toFixed(1)}`
}

const REPLY_MARGIN_CP = 30

/** Opponent reply: top engine move, or a random pick among near-equal alternatives. */
function pickEngineReply(lines: EngineAnalysisLine[]): string | undefined {
  if (!lines.length) return undefined
  const best = evalValue(lines[0])
  const candidates = lines.filter((line) => best - evalValue(line) <= REPLY_MARGIN_CP)
  const chosen = candidates[Math.floor(Math.random() * candidates.length)]
  return (chosen ?? lines[0]).move
}

/**
 * Approval rule: the move is approved when
 *  1. it is within MARGIN_CP of the engine's best line, and
 *  2. it does not flip a non-negative position negative (if the best line
 *     keeps you >= 0, a "close" move that goes negative does not count).
 * When the whole position is already lost (best < 0), rule 2 is waived.
 */
function judgeMove(uci: string, san: string, fen: string, lines: EngineAnalysisLine[]): Pick {
  const best = lines[0]
  if (!best) return { uci, san, approved: true, reason: 'engine-unavailable', cpLabel: null, bestSan: san, bestLabel: '—' }
  const bestVal = evalValue(best)
  const played = lines.find((line) => line.move === uci)
  const bestSanLabel = sanFor(fen, best.move) ?? best.move
  if (!played) {
    return { uci, san, approved: false, reason: 'outside-top', cpLabel: null, bestSan: bestSanLabel, bestLabel: fmtEval(best) }
  }
  const playedVal = evalValue(played)
  const marginOk = bestVal - playedVal <= MARGIN_CP
  const nonNegativeOk = bestVal < 0 || playedVal >= 0
  const approved = marginOk && nonNegativeOk
  const reason: PickReason = approved
    ? 'approved'
    : !marginOk ? 'loses-margin' : 'negates-advantage'
  return { uci, san, approved, reason, cpLabel: fmtEval(played), bestSan: bestSanLabel, bestLabel: fmtEval(best) }
}

function App() {
  const [store, setStore] = useState<Store>(loadStore)
  const [profileId, setProfileId] = useState<string | null>(store.activeProfileId)
  const profile = store.profiles.find((candidate) => candidate.id === profileId) ?? null
  const [showProfiles, setShowProfiles] = useState(!profile)
  const [run, setRun] = useState<RunState | null>(null)
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [feedback, setFeedback] = useState<JudgeFeedback | null>(null)
  const [feedbackAtIndex, setFeedbackAtIndex] = useState<number | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [opponentThinking, setOpponentThinking] = useState(false)

  const engine: EngineAdapter = useMemo(() => createEngineAdapter(), [])
  const analysisCache = useRef(new Map<string, Promise<EngineAnalysis>>())
  const analysisQueue = useRef<Promise<void>>(Promise.resolve())

  function analyzeCached(fen: string, options: { depth: number; multipv: number; maxTimeMs: number }) {
    const key = `${fen}|${options.depth}|${options.multipv}|${options.maxTimeMs}`
    const cached = analysisCache.current.get(key)
    if (cached) return cached

    const request = analysisQueue.current.then(() => engine.analyzePosition(fen, options)).catch((error: unknown) => {
      analysisCache.current.delete(key)
      throw error
    })
    analysisQueue.current = request.then(() => undefined, () => undefined)
    analysisCache.current.set(key, request)
    if (analysisCache.current.size > 32) {
      const oldestKey = analysisCache.current.keys().next().value
      if (oldestKey !== undefined && oldestKey !== key) analysisCache.current.delete(oldestKey)
    }
    return request
  }

  function playerAnalysisOptions(candidateId: string) {
    const engineTimeMs = store.profiles.find((candidate) => candidate.id === candidateId)?.settings.engineTimeMs ?? 2000
    return { depth: 16, multipv: JUDGE_MULTIPV, maxTimeMs: engineTimeMs }
  }

  function warmPlayerAnalysis(fen: string, candidateId: string) {
    void analyzeCached(fen, playerAnalysisOptions(candidateId)).catch(() => undefined)
  }

  const games = useMemo(() => {
    const synced = profile?.syncedPgn ? gamesFromPgn(profile.syncedPgn) : []
    return [...gameLibrary, ...synced]
  }, [profile?.syncedPgn])

  const game = useMemo(() => (run ? new Chess(run.line[run.lineIndex]) : null), [run])

  function patchProfile(id: string, update: (candidate: Profile) => Profile) {
    setStore((previous) => {
      const next: Store = { ...previous, profiles: previous.profiles.map((candidate) => candidate.id === id ? update(candidate) : candidate) }
      saveStore(next)
      return next
    })
  }

  function startRun(candidateId: string, game: GameRecord, startPly: number, phase: Phase, cursorIndex: number) {
    patchProfile(candidateId, (candidate) => ({ ...candidate, cursor: cursorIndex + 1 }))
    const startFen = fenAfterMoves(game.moves, startPly)
    setRun({
      game,
      startPly,
      phase,
      line: [startFen],
      movesUci: [],
      moveEvalLabels: [],
      lineIndex: 0,
      picks: [],
      done: false,
    })
    warmPlayerAnalysis(startFen, candidateId)
    setSelectedSquare(null)
    setFeedback(null)
    setFeedbackAtIndex(null)
    setShowProfiles(false)
  }

  function openProfile(id: string) {
    const opened = store.profiles.find((candidate) => candidate.id === id)
    if (!opened) return
    const nextStore: Store = { ...store, activeProfileId: id }
    setStore(nextStore)
    saveStore(nextStore)
    setProfileId(id)
    setShowProfiles(false)

    const library = [...gameLibrary, ...(opened.syncedPgn ? gamesFromPgn(opened.syncedPgn) : [])]
    // Start a fresh random game when the profile is opened. Avoid immediately
    // repeating the saved game the player was on before the app was closed.
    const next = nextGame(library, opened.session?.gameId)
    startRun(opened.id, next.game, next.startPly, next.phase, next.index)
  }

  function createAndOpenProfile(name: string) {
    const created = createProfile(name)
    const nextStore: Store = { activeProfileId: created.id, profiles: [...store.profiles, created] }
    setStore(nextStore)
    saveStore(nextStore)
    setProfileId(created.id)
    const next = nextGame(gameLibrary)
    startRun(created.id, next.game, next.startPly, next.phase, next.index)
  }

  function deleteProfile(id: string) {
    const remaining = store.profiles.filter((candidate) => candidate.id !== id)
    const nextStore: Store = { activeProfileId: store.activeProfileId === id ? null : store.activeProfileId, profiles: remaining }
    setStore(nextStore)
    saveStore(nextStore)
    if (id === profileId) {
      setProfileId(null)
      setRun(null)
      setShowProfiles(true)
    }
  }

  async function syncGames(id: string, username: string) {
    const pgn = await fetchLichessPgn(username)
    patchProfile(id, (candidate) => ({ ...candidate, syncedPgn: pgn }))
  }

  // Persist the run after every change.
  useEffect(() => {
    if (!profileId || !run) return
    const { game: currentGame, ...rest } = run
    patchProfile(profileId, (candidate) => ({ ...candidate, session: { gameId: currentGame.id, ...rest } }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, run])

  function applyMove(fenBefore: string, uci: string) {
    const chess = new Chess(fenBefore)
    const move = chess.move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      ...(uci[4] ? { promotion: uci[4] as 'q' | 'r' | 'b' | 'n' } : {}),
    })
    return { san: move?.san ?? uci, fenAfter: chess.fen() }
  }

  /**
   * Opponent reply comes from the engine: top move usually, but when a lower
   * line is nearly equal, one of the close lines is picked at random so the
   * opponent is not perfectly predictable.
   */
  function playOpponentMove(current: RunState, fenAfterPlayerMove: string) {
    setOpponentThinking(true)
    void analyzeCached(fenAfterPlayerMove, { depth: 12, multipv: 3, maxTimeMs: OPPONENT_THINK_MS })
      .then((result) => {
        const uci = pickEngineReply(result.lines)
        if (!uci) throw new Error('no engine reply')
        const replyLine = result.lines.find((line) => line.move === uci)
        finishOpponentMove(current, uci, applyMove(fenAfterPlayerMove, uci), fmtEval(replyLine, true))
      })
      .catch(() => finishOpponentMove(current, null, undefined))
      .finally(() => setOpponentThinking(false))
  }

  function finishOpponentMove(current: RunState, uci: string | null, applied?: { san: string; fenAfter: string }, replyEval?: string) {
    if (uci && applied) {
      const picks = current.picks.map((pick, index) => index === current.picks.length - 1 && pick.cpLabel === null && replyEval
        ? { ...pick, cpLabel: replyEval }
        : pick)
      setFeedback((previous) => (previous ? { ...previous, pick: picks[picks.length - 1] ?? previous.pick, opponentReply: applied.san } : previous))
      setRun(() => {
        const line = [...current.line, applied.fenAfter]
        const movesUci = [...current.movesUci, uci]
        const moveEvalLabels = [...current.moveEvalLabels]
        if (picks.length && picks[picks.length - 1].cpLabel !== current.picks[current.picks.length - 1]?.cpLabel) {
          moveEvalLabels[moveEvalLabels.length - 1] = picks[picks.length - 1].cpLabel
        }
        moveEvalLabels.push(replyEval ?? null)
        return { ...current, line, movesUci, moveEvalLabels, picks, lineIndex: line.length - 1, done: new Chess(applied.fenAfter).isGameOver() }
      })
      warmPlayerAnalysis(applied.fenAfter, profileId ?? '')
      return
    }
    // No reply available (engine failed): the game cannot continue; mark done.
    setRun((previous) => (previous ? { ...previous, done: true } : previous))
  }

  function commitPlayerMove(sourceSquare: Square, targetSquare: Square) {
    if (!run || !profile || isAnalyzing || opponentThinking || run.done) return false
    if (game!.turn() !== playerSide(run.startPly)) return false
    const fenBefore = run.line[run.lineIndex]
    const probe = new Chess(fenBefore)
    let san: string
    try {
      const move = probe.move({ from: sourceSquare, to: targetSquare, promotion: 'q' })
      if (!move) return false
      san = move.san
    } catch {
      return false
    }
    const uci = `${sourceSquare}${targetSquare}`
    const fenAfter = probe.fen()
    const movesUci = [...run.movesUci.slice(0, run.lineIndex), uci]
    const line = [...run.line.slice(0, run.lineIndex + 1), fenAfter]
    const moveEvalLabels = [...run.moveEvalLabels.slice(0, run.lineIndex), null]
    const optimisticRun: RunState = { ...run, line, movesUci, moveEvalLabels, lineIndex: line.length - 1 }

    // Commit the visual move immediately; only the verdict waits on the engine.
    setRun(optimisticRun)
    setIsAnalyzing(true)
    setFeedback(null)
    setFeedbackAtIndex(null)
    void analyzeCached(fenBefore, playerAnalysisOptions(profile.id))
      .then((result) => {
        const picksBefore = Math.floor((run.lineIndex + 1) / 2)
        const pick = judgeMove(uci, san, fenBefore, result.lines)
        const picks = [...run.picks.slice(0, picksBefore), pick]
        const chainAfter = trailingChain(picks)
        const achieved = bestChainIn(picks) >= GOAL_CHAIN
        const achievedBefore = bestChainIn(run.picks) >= GOAL_CHAIN

        const evaluatedRun: RunState = { ...optimisticRun, moveEvalLabels: [...moveEvalLabels.slice(0, -1), pick.cpLabel], picks }
        setRun(evaluatedRun)
        setFeedbackAtIndex(evaluatedRun.lineIndex)

        const alternatives: PickAlternative[] = result.lines.slice(0, 3)
          .map((engineLine) => ({ san: sanFor(fenBefore, engineLine.move) ?? engineLine.move, score: fmtEval(engineLine) }))
        setFeedback({ pick, chain: chainAfter, alternatives, opponentReply: undefined })

        patchProfile(profile.id, (candidate) => noteMilestone(candidate, !achievedBefore && achieved, chainAfter))
        playOpponentMove(evaluatedRun, fenAfter)
      })
      .catch(() => {
        setRun(run)
        setFeedback(null)
      })
      .finally(() => setIsAnalyzing(false))
    setSelectedSquare(null)
    return true
  }

  function onSquareClick(square: string) {
    if (!run || !game || isAnalyzing || opponentThinking || run.done) return
    if (game.turn() !== playerSide(run.startPly)) return
    const clicked = square as Square
    const piece = game.get(clicked)
    if (!selectedSquare) {
      if (piece && piece.color === game.turn()) setSelectedSquare(clicked)
      return
    }
    if (clicked === selectedSquare) {
      setSelectedSquare(null)
      return
    }
    if (!commitPlayerMove(selectedSquare, clicked) && piece?.color === game.turn()) setSelectedSquare(clicked)
  }

  function goBack() {
    if (!run || run.lineIndex === 0 || isAnalyzing) return
    setRun({ ...run, lineIndex: run.lineIndex - 1 })
    setSelectedSquare(null)
  }

  function goForward() {
    if (!run || run.lineIndex >= run.line.length - 1 || isAnalyzing) return
    setRun({ ...run, lineIndex: run.lineIndex + 1 })
    setSelectedSquare(null)
  }

  function nextGameRun() {
    if (!profile || !run) return
    patchProfile(profile.id, (candidate) => noteGameFinished(candidate, bestChainIn(run.picks)))
    const next = nextGame(games, run.game.id)
    startRun(profile.id, next.game, next.startPly, next.phase, next.index)
  }

  function cycleThinkTime() {
    if (!profile) return
    const next = THINK_TIMES[(THINK_TIMES.indexOf(profile.settings.engineTimeMs) + 1) % THINK_TIMES.length]
    patchProfile(profile.id, (candidate) => ({ ...candidate, settings: { engineTimeMs: next } }))
  }

  if (showProfiles || !profile || !run) {
    return (
      <ProfileScreen
        store={store}
        activeId={profileId}
        onOpen={openProfile}
        onCreate={createAndOpenProfile}
        onDelete={deleteProfile}
        onSync={syncGames}
      />
    )
  }

  const chain = trailingChain(run.picks)
  const achieved = bestChainIn(run.picks) >= GOAL_CHAIN
  const showNextGame = achieved || run.done
  const fullMoveNumber = Math.floor((run.startPly + run.lineIndex) / 2) + 1
  const lastMoveUci = run.lineIndex > 0
    ? run.movesUci[run.lineIndex - 1]
    : run.startPly > 0 ? run.game.moves[run.startPly - 1] : undefined
  const squareStyles: Record<string, { boxShadow: string }> = {}
  if (lastMoveUci) {
    const highlight = 'inset 0 0 0 999px rgba(207, 205, 113, .32)'
    squareStyles[lastMoveUci.slice(0, 2)] = { boxShadow: highlight }
    squareStyles[lastMoveUci.slice(2, 4)] = { boxShadow: highlight }
  }
  if (selectedSquare) {
    const selection = 'inset 0 0 0 3px rgba(166, 214, 200, .95)'
    const previous = squareStyles[selectedSquare]?.boxShadow
    squareStyles[selectedSquare] = { boxShadow: previous ? `${previous}, ${selection}` : selection }
  }

  return (
    <main className="app-shell">
      <header className="topbar slim">
        <button className="profile-name-button" onClick={() => setShowProfiles(true)} aria-label="Switch profile">{profile.name}</button>
        <span className="run-counter">Move {fullMoveNumber} · Run {chain}/{GOAL_CHAIN}</span>
        <span className="streak"><span>◒</span>{profile.streak.current > 0 ? profile.streak.current : '—'}</span>
      </header>

      <section className="training-layout">
        <div className="board-column">
          <div className="board-wrap">
            <Chessboard options={{
              position: game!.fen(),
              onSquareClick: ({ square }) => onSquareClick(square),
              boardOrientation: playerSide(run.startPly) === 'w' ? 'white' : 'black',
              allowDragging: false,
              squareStyles,
              animationDurationInMs: 180,
              boardStyle: { borderRadius: '12px', overflow: 'hidden' },
              darkSquareStyle: { backgroundColor: '#52748a' },
              lightSquareStyle: { backgroundColor: '#dce8e3' },
            }} />
          </div>

          <div className="board-nav-row">
            <div className="line-controls">
              <button onClick={goBack} disabled={run.lineIndex === 0 || isAnalyzing || opponentThinking}>← Back</button>
              <span>{run.lineIndex} / {run.line.length - 1}</span>
              <button onClick={goForward} disabled={run.lineIndex >= run.line.length - 1 || isAnalyzing || opponentThinking}>Forward →</button>
            </div>
            {showNextGame && <button className="next-button" onClick={nextGameRun} disabled={isAnalyzing || opponentThinking}>Next game →</button>}
          </div>

          <MoveFeedbackList feedback={feedback && (feedbackAtIndex === null || run.lineIndex >= feedbackAtIndex) ? feedback : null} isAnalyzing={isAnalyzing} opponentThinking={opponentThinking} />

          <div className="game-meta">Game {run.game.id.slice(0, 8)} · {run.phase}</div>
          <HistoryList run={run} onJump={(ply) => { setRun({ ...run, lineIndex: ply }); setSelectedSquare(null) }} />

          <div className="game-controls">
            <button className="think-button" onClick={cycleThinkTime} title="Engine think time per move">Engine {profile.settings.engineTimeMs / 1000}s</button>
            {!showNextGame && <button className="skip-button" onClick={() => startRun(profile.id, run.game, run.startPly, run.phase, profile.cursor - 1)}>Restart</button>}
          </div>

          {run.done && <p className="game-result">{gameResultText(run, achieved, game!.fen())}</p>}
          <div className="game-players">{run.game.white} vs {run.game.black}{run.game.opening ? ` · ${run.game.eco} ${run.game.opening}` : ''}</div>
        </div>
      </section>

      <footer className="app-footer"><span>{isAnalyzing || opponentThinking ? 'Engine thinking' : ' '}</span></footer>
    </main>
  )
}

function gameResultText(run: RunState, achieved: boolean, fen: string): string {
  const chess = new Chess(fen)
  let outcome: string
  if (chess.isCheckmate()) outcome = `Checkmate — ${chess.turn() === 'w' ? 'Black' : 'White'} wins`
  else if (chess.isDraw() || chess.isStalemate()) outcome = 'Drawn'
  else outcome = 'Game stopped'
  const reached = achieved ? 'You completed the run — 3 approved picks in a row.' : `Your best run this game: ${bestChainIn(run.picks)} in a row.`
  return `${outcome} · ${reached}`
}

function MoveFeedbackList({ feedback, isAnalyzing, opponentThinking }: {
  feedback: JudgeFeedback | null
  isAnalyzing: boolean
  opponentThinking: boolean
}) {
  if (!feedback) {
    return isAnalyzing ? <div className="moves-status">Checking your move…</div> : null
  }

  const { pick, alternatives } = feedback
  const included = alternatives.some((line) => line.san === pick.san)
  return <section className="move-feedback" aria-live="polite">
    <div className="move-feedback-heading">
      <span>TOP MOVES</span>
      {opponentThinking && <small>Opponent thinking…</small>}
      {!opponentThinking && pick.reason === 'engine-unavailable' && <small>Engine unavailable</small>}
    </div>
    <div className="move-options">
      {alternatives.map((line, index) => {
        const isPicked = line.san === pick.san
        return <div key={`${line.san}-${index}`} className={`move-option ${isPicked ? pick.approved ? 'picked-approved' : 'picked-rejected' : ''}`}>
          <span className="move-rank">{index + 1}</span>
          <b>{line.san}</b>
          <span className="move-eval">{line.score}</span>
          {isPicked && <span className="move-mark">{pick.approved ? '✓' : '✕'}</span>}
        </div>
      })}
      {!included && <div className={`move-option ${pick.approved ? 'picked-approved' : 'picked-rejected'} played-outside`}>
        <span className="move-rank">4</span>
        <b>{pick.san}</b>
        <span className="move-eval">{pick.cpLabel ?? (pick.reason === 'outside-top' ? '—' : '—')}</span>
        <span className="move-mark">{pick.approved ? '✓' : '✕'}</span>
      </div>}
    </div>
  </section>
}

/** Every move of the game so far; player moves carry their approval verdict. Click to jump. */
function HistoryList({ run, onJump }: { run: RunState; onJump: (lineIndex: number) => void }) {
  const rows = run.movesUci.map((uci, ply) => {
    const san = sanFor(run.line[ply], uci) ?? uci
    const isPlayerMove = ply % 2 === 0
    const pick = isPlayerMove ? run.picks[ply / 2] : undefined
    return { ply, san, isPlayerMove, pick, evalLabel: run.moveEvalLabels[ply] ?? pick?.cpLabel ?? null }
  })
  if (!rows.length) return null
  return <div className="history-block">
    <div className="history-heading">HISTORY</div>
    <div className="history-list">
      {rows.map((row) => (
        <button
          key={row.ply}
          className={`history-row ${row.ply + 1 === run.lineIndex ? 'current' : ''}`}
          onClick={() => onJump(row.ply + 1)}
        >
          <span className="history-ply">{Math.floor((run.startPly + row.ply) / 2) + 1}{(run.startPly + row.ply) % 2 === 0 ? '.' : '…'}</span>
          <b>{row.san}</b>
          {row.pick && <span className={`history-verdict ${row.pick.approved ? 'ok' : 'bad'}`}>{row.pick.approved ? '✓' : '✕'}</span>}
          <em className="history-eval">{row.evalLabel ?? '—'}</em>
        </button>
      ))}
    </div>
  </div>
}

function ProfileScreen({ store, activeId, onOpen, onCreate, onDelete, onSync }: {
  store: Store
  activeId: string | null
  onOpen: (id: string) => void
  onCreate: (name: string) => void
  onDelete: (id: string) => void
  onSync: (id: string, username: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [syncUser, setSyncUser] = useState('')
  const [syncTarget, setSyncTarget] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)

  async function sync(target: Profile) {
    setSyncTarget(target.id)
    setSyncStatus(`Fetching ${syncUser}'s games…`)
    try {
      await onSync(target.id, syncUser)
      setSyncStatus(`Synced games for ${target.name}.`)
      setSyncUser('')
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : 'Sync failed')
    } finally {
      setSyncTarget(null)
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">♞</div>
        <div><p className="eyebrow">NO-BLUNDER RUN</p><h1>Who is training?</h1></div>
      </header>
      <section className="profile-screen">
        {store.profiles.map((profile) => (
          <div className="profile-card" key={profile.id}>
            <button className="profile-open" onClick={() => onOpen(profile.id)}>
              <b>{profile.name}{profile.id === activeId ? ' · current' : ''}</b>
              <small>{profile.stats.gamesPlayed} games · {profile.stats.runsAchieved} runs · best {profile.stats.bestRun}{profile.streak.current > 0 ? ` · ${profile.streak.current} day streak` : ''}</small>
            </button>
            <button className="profile-delete" aria-label={`Delete ${profile.name}`} onClick={() => onDelete(profile.id)}>✕</button>
          </div>
        ))}
        <form className="profile-create" onSubmit={(event) => { event.preventDefault(); if (name.trim()) { onCreate(name); setName('') } }}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="New player name" maxLength={24} />
          <button type="submit">Add player</button>
        </form>
        {store.profiles.length > 0 && (
          <form className="profile-create" onSubmit={(event) => {
            event.preventDefault()
            const target = store.profiles.find((profile) => profile.id === activeId) ?? store.profiles[0]
            if (syncUser.trim()) void sync(target)
          }}>
            <input value={syncUser} onChange={(event) => setSyncUser(event.target.value)} placeholder="Lichess username to sync games" maxLength={30} />
            <button type="submit" disabled={!syncUser.trim() || syncTarget !== null}>Sync games</button>
          </form>
        )}
        {syncStatus && <p className="profile-note">{syncStatus}</p>}
        <p className="profile-note">Runs, streaks, and open games are saved in this browser only. Synced games come straight from lichess.org.</p>
      </section>
    </main>
  )
}

export default App
