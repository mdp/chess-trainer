import { useEffect, useMemo, useState } from 'react'
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

function fmtEval(line: EngineAnalysisLine | undefined): string {
  if (!line) return '—'
  if (line.mateIn !== undefined) return `M${line.mateIn > 0 ? '' : '−'}${Math.abs(line.mateIn)}`
  if (line.scoreCp === undefined) return '—'
  return `${line.scoreCp >= 0 ? '+' : '−'}${(Math.abs(line.scoreCp) / 100).toFixed(1)}`
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
  const [rootAnalysis, setRootAnalysis] = useState<EngineAnalysis | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [selectedEngineLine, setSelectedEngineLine] = useState<string | null>(null)
  const [opponentThinking, setOpponentThinking] = useState(false)

  const engine: EngineAdapter = useMemo(() => createEngineAdapter(), [])

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
    setRun({
      game,
      startPly,
      phase,
      line: [fenAfterMoves(game.moves, startPly)],
      movesUci: [],
      lineIndex: 0,
      picks: [],
      done: false,
    })
    setSelectedSquare(null)
    setFeedback(null)
    setRootAnalysis(null)
    setSelectedEngineLine(null)
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
    const saved = opened.session
    const savedGame = saved ? library.find((game) => game.id === saved.gameId) : undefined
    if (saved && savedGame && saved.line.length) {
      setRun({
        game: savedGame,
        startPly: saved.startPly,
        phase: saved.phase,
        line: saved.line,
        movesUci: saved.movesUci,
        lineIndex: Math.min(saved.lineIndex, saved.line.length - 1),
        picks: saved.picks,
        done: saved.done,
      })
    } else {
      const next = nextGame(library, opened.cursor, null)
      startRun(opened.id, next.game, next.startPly, next.phase, next.index)
    }
  }

  function createAndOpenProfile(name: string) {
    const created = createProfile(name)
    const nextStore: Store = { activeProfileId: created.id, profiles: [...store.profiles, created] }
    setStore(nextStore)
    saveStore(nextStore)
    setProfileId(created.id)
    const next = nextGame(gameLibrary, 0, null)
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
    void engine.analyzePosition(fenAfterPlayerMove, { depth: 12, multipv: 3, maxTimeMs: OPPONENT_THINK_MS })
      .then((result) => {
        const uci = pickEngineReply(result.lines)
        if (!uci) throw new Error('no engine reply')
        finishOpponentMove(current, uci, applyMove(fenAfterPlayerMove, uci))
      })
      .catch(() => finishOpponentMove(current, null, undefined))
      .finally(() => setOpponentThinking(false))
  }

  function finishOpponentMove(current: RunState, uci: string | null, applied?: { san: string; fenAfter: string }) {
    if (uci && applied) {
      setFeedback((previous) => (previous ? { ...previous, opponentReply: applied.san } : previous))
      setRun(() => {
        const line = [...current.line, applied.fenAfter]
        const movesUci = [...current.movesUci, uci]
        return { ...current, line, movesUci, lineIndex: line.length - 1, done: new Chess(applied.fenAfter).isGameOver() }
      })
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
    try {
      const move = probe.move({ from: sourceSquare, to: targetSquare, promotion: 'q' })
      if (!move) return false
    } catch {
      return false
    }
    const uci = `${sourceSquare}${targetSquare}`

    setIsAnalyzing(true)
    void engine.analyzePosition(fenBefore, { depth: 16, multipv: JUDGE_MULTIPV, maxTimeMs: profile.settings.engineTimeMs })
      .then((result) => {
        setRootAnalysis(result)
        const { san, fenAfter } = applyMove(fenBefore, uci)

        // The played line up to and including this move (rewinds included).
        const movesUci = [...run.movesUci.slice(0, run.lineIndex), uci]
        const line = [...run.line.slice(0, run.lineIndex + 1), fenAfter]
        const picksBefore = Math.floor((run.lineIndex + 1) / 2)
        const pick = judgeMove(uci, san, fenBefore, result.lines)
        const picks = [...run.picks.slice(0, picksBefore), pick]
        const chainAfter = trailingChain(picks)
        const achieved = bestChainIn(picks) >= GOAL_CHAIN
        const achievedBefore = bestChainIn(run.picks) >= GOAL_CHAIN

        const nextRun: RunState = { ...run, line, movesUci, lineIndex: line.length - 1, picks }
        setRun(nextRun)

        const alternatives: PickAlternative[] = result.lines.slice(0, 3)
          .map((engineLine) => ({ san: sanFor(fenBefore, engineLine.move) ?? engineLine.move, score: fmtEval(engineLine) }))
        setFeedback({ pick, chain: chainAfter, alternatives, opponentReply: undefined })

        patchProfile(profile.id, (candidate) => noteMilestone(candidate, !achievedBefore && achieved, chainAfter))
        playOpponentMove(nextRun, fenAfter)
      })
      .catch(() => setIsAnalyzing(false))
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
    const next = nextGame(games, profile.cursor, run.game.id)
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
  const blunders = run.picks.filter((pick) => !pick.approved).length
  const achieved = bestChainIn(run.picks) >= GOAL_CHAIN
  const isPlayerTurn = game!.turn() === playerSide(run.startPly)
  const showNextGame = achieved || run.done
  const thinkLabel = `${(profile.settings.engineTimeMs / 1000).toFixed(0)}s`

  return (
    <main className="app-shell">
      <header className="topbar slim">
        <div className="brand-mark">♞</div>
        <span className="profile-name">{profile.name}</span>
        <div className="streak"><span>◒</span> {profile.streak.current > 0 ? `${profile.streak.current}` : '—'}</div>
      </header>

      <section className="training-layout">
        <div className="board-column">
          <div className="exercise-meta">
            <div>
              <span className={`mode-pill ${achieved ? 'achieved' : ''}`}>{achieved ? 'RUN COMPLETE' : `RUN ${chain}/${GOAL_CHAIN}`}</span>
              <span className="exercise-count">Best {Math.max(profile.stats.bestRun, bestChainIn(run.picks))} · Blunders {blunders}</span>
            </div>
            <button className="icon-button" aria-label="Switch player" onClick={() => setShowProfiles(true)}>☷</button>
          </div>

          <div className="prompt-card">
            <span className="prompt-kicker">{run.done ? 'GAME OVER' : isPlayerTurn ? (isAnalyzing ? 'ENGINE CHECKING' : 'YOUR MOVE') : opponentThinking ? 'OPPONENT THINKING' : 'OPPONENT MOVE'}</span>
            <h2>
              {run.done
                ? gameResultText(run, achieved, game!.fen())
                : isPlayerTurn
                  ? 'Pick a move that keeps you on top.'
                  : 'The engine opponent is choosing its reply.'}
            </h2>
            <p>
              {run.game.white}{run.game.whiteElo ? ` (${run.game.whiteElo})` : ''} vs {run.game.black}{run.game.blackElo ? ` (${run.game.blackElo})` : ''}
              {run.game.opening ? ` · ${run.game.eco} ${run.game.opening}` : ''} · {run.phase}
            </p>
          </div>

          <div className="board-wrap">
            <Chessboard options={{
              position: game!.fen(),
              onSquareClick: ({ square }) => onSquareClick(square),
              boardOrientation: playerSide(run.startPly) === 'w' ? 'white' : 'black',
              allowDragging: false,
              squareStyles: selectedSquare ? { [selectedSquare]: { boxShadow: 'inset 0 0 0 4px rgba(166, 214, 200, .9)' } } : {},
              animationDurationInMs: 180,
              boardStyle: { borderRadius: '12px', overflow: 'hidden' },
              darkSquareStyle: { backgroundColor: '#52748a' },
              lightSquareStyle: { backgroundColor: '#dce8e3' },
            }} />
          </div>

          <div className="board-footer">
            <span><i className="turn-dot" /> {game!.turn() === 'w' ? 'White' : 'Black'} to move</span>
            <div className="line-controls">
              <button onClick={goBack} disabled={run.lineIndex === 0 || isAnalyzing}>← Back</button>
              <span>{run.lineIndex} / {run.line.length - 1}</span>
              <button onClick={goForward} disabled={run.lineIndex >= run.line.length - 1 || isAnalyzing}>Forward →</button>
            </div>
          </div>

          <div className="below-board">
            <p><b>Goal:</b> {GOAL_CHAIN} approved moves in a row. Approved = within 0.5 pawns of the engine's best line, and it never flips a non-negative position negative.</p>
            <div className="extras-row">
              <span>{profile.stats.gamesPlayed} games · {profile.stats.runsAchieved} runs</span>
              <button className="think-button" onClick={cycleThinkTime} title="Engine think time per move">◉ {thinkLabel}</button>
            </div>
          </div>
        </div>

        <aside className="insight-panel">
          {feedback
            ? <JudgeCard feedback={feedback} opponentThinking={opponentThinking} />
            : <div className="thinking-note"><span className="note-icon">◎</span><div><strong>{isAnalyzing ? 'Reading the position…' : 'Take your time'}</strong><p>{isAnalyzing ? `Berserk is checking the top ${JUDGE_MULTIPV} (${thinkLabel}).` : 'Every pick is judged: margin to the best line, and it must not negate your advantage.'}</p></div></div>}

          {rootAnalysis && <EnginePanel analysis={rootAnalysis} selectedEngineLine={selectedEngineLine} onSelect={setSelectedEngineLine} />}

          {showNextGame && <button className="next-button" onClick={nextGameRun}>Next game <span>→</span></button>}
          {!showNextGame && (
            <button className="skip-button" onClick={() => {
              startRun(profile.id, run.game, run.startPly, run.phase, profile.cursor - 1)
              setFeedback(null)
              setRootAnalysis(null)
            }}>Restart game</button>
          )}

          <HistoryList run={run} onJump={(ply) => { setRun({ ...run, lineIndex: ply }); setSelectedSquare(null) }} />
        </aside>
      </section>

      <footer className="app-footer"><span>{isAnalyzing || opponentThinking ? 'Engine: analyzing' : 'Engine: Berserk WASM'}</span></footer>
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

const REASON_TEXT: Record<PickReason, string> = {
  approved: 'Within 0.5 pawns of the best line, without giving up the advantage.',
  'outside-top': 'Not in the engine’s top 5 — too far from the best line to count.',
  'negates-advantage': 'A close move that flips a non-negative position negative does not count. You had a line that kept the advantage.',
  'loses-margin': 'More than 0.5 pawns worse than the best line.',
  'engine-unavailable': 'The engine could not check this move; it counts as approved.',
}

function JudgeCard({ feedback, opponentThinking }: { feedback: JudgeFeedback; opponentThinking: boolean }) {
  const { pick, chain, alternatives, opponentReply } = feedback
  const isBest = pick.san === pick.bestSan
  return <div className="feedback-card">
    <div className="result-heading">
      <span className={`result-check ${pick.approved ? '' : 'fail'}`}>{pick.approved ? '✓' : '✕'}</span>
      <div>
        <span className="result-label">{pick.approved ? `APPROVED · RUN ${chain}` : 'NOT APPROVED · RUN RESET'}</span>
        <h3>{pick.san} {pick.approved ? 'keeps the run alive' : 'resets the run'}</h3>
      </div>
    </div>
    <div className="eval-row">
      <div><span>YOURS</span><b>{pick.san}</b><em>{pick.cpLabel ?? '—'}</em></div>
      <div><span>BEST</span><b>{pick.bestSan}</b><em>{pick.bestLabel}</em></div>
    </div>
    <p>
      {pick.approved && isBest ? 'That was the engine’s first choice. ' : ''}
      {REASON_TEXT[pick.reason]}
    </p>
    <div className="move-ideas">
      <span>ENGINE TOP 3</span>
      {alternatives.map((line, index) => <div key={`${line.san}-${index}`} className={line.san === pick.san ? 'chosen-move' : ''}>{index + 1}. {line.san} <em>{line.score}</em></div>)}
    </div>
    {opponentReply || opponentThinking ? <div className="opponent-idea"><span className="lesson-label">OPPONENT</span><p>{opponentThinking && !opponentReply ? 'Choosing a reply…' : <>Their reply: <b>{opponentReply}</b></>}</p></div> : null}
  </div>
}

function EnginePanel({ analysis, selectedEngineLine, onSelect }: { analysis: EngineAnalysis | null; selectedEngineLine: string | null; onSelect: (move: string | null) => void }) {
  if (!analysis || !analysis.lines.length) return null
  return <div className="engine-panel">
    <div className="engine-panel-heading"><span>ENGINE LINES</span><small>position before your move</small></div>
    {analysis.lines.slice(0, 3).map((line, index) => (
      <button className={`engine-line ${selectedEngineLine === line.move ? 'chosen' : ''}`} key={`${line.move}-${index}`} onClick={() => onSelect(selectedEngineLine === line.move ? null : line.move)}>
        <strong>{index + 1}</strong>
        <b>{lineLabel(analysis.fen, line)}</b>
        <span>{fmtEval(line)}</span>
        {selectedEngineLine === line.move ? <small>{formatPv(analysis.fen, line.pv)}</small> : null}
      </button>
    ))}
  </div>
}

/** Every move of the game so far; player moves carry their approval verdict. Click to jump. */
function HistoryList({ run, onJump }: { run: RunState; onJump: (lineIndex: number) => void }) {
  const rows = run.movesUci.map((uci, ply) => {
    const san = sanFor(run.line[ply], uci) ?? uci
    const isPlayerMove = ply % 2 === 0
    const pick = isPlayerMove ? run.picks[ply / 2] : undefined
    return { ply, san, isPlayerMove, pick }
  })
  if (!rows.length) return null
  return <div className="history-block">
    <div className="panel-label">GAME HISTORY</div>
    <div className="history-list">
      {rows.map((row) => (
        <button
          key={row.ply}
          className={`history-row ${row.ply === run.lineIndex ? 'current' : ''} ${row.isPlayerMove ? 'player' : 'engine'}`}
          onClick={() => onJump(row.ply + 1)}
        >
          <span className="history-ply">{Math.floor(row.ply / 2) + 1}{row.ply % 2 === 0 ? '.' : '…'}</span>
          <b>{row.san}</b>
          {row.pick ? (
            <em className={row.pick.approved ? 'ok' : 'bad'}>
              {row.pick.approved ? '✓' : '✕'} {row.pick.cpLabel ?? '?'} <small>vs {row.pick.bestLabel}</small>
            </em>
          ) : <em className="reply">↩</em>}
        </button>
      ))}
    </div>
  </div>
}

function lineLabel(fen: string, line: EngineAnalysisLine) {
  try {
    const chess = new Chess(fen)
    const move = chess.move({ from: line.move.slice(0, 2) as Square, to: line.move.slice(2, 4) as Square, promotion: line.move[4] as 'q' | 'r' | 'b' | 'n' | undefined })
    return move?.san ?? line.move
  } catch { return line.move }
}

function formatPv(fen: string, pv?: string[]) {
  if (!pv?.length) return 'No continuation returned'
  try {
    const chess = new Chess(fen)
    return pv.slice(0, 6).map((uci) => {
      const move = chess.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined })
      return move?.san ?? uci
    }).join(' ')
  } catch { return pv.slice(0, 6).join(' ') }
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
