import { useEffect, useMemo, useState } from 'react'
import { Chess, type Square } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { createEngineAdapter, type EngineAdapter, type EngineAnalysis, type EngineAnalysisLine } from './engineAdapter'
import { describePosition } from './positionAnalysis'
import { fenAfterMoves, gameLibrary, nextGame, sanFor, type GameRecord, type Phase } from './gameData'
import { fetchLichessPgn, gamesFromPgn } from './lichess'
import { createProfile, loadStore, noteGameFinished, noteMilestone, saveStore, type Profile, type Store } from './storage'
import type { RunFeedback } from './types'

/** Consecutive top-3 picks needed to complete a game's run. */
const GOAL_CHAIN = 3
/** Quick think time for the opponent when the recorded game no longer applies. */
const OPPONENT_THINK_MS = 600
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
  /** Judgement of each player move in order: was it in the engine top 3? */
  picks: boolean[]
  done: boolean
}

/** Consecutive successes at the end of the pick list. */
function trailingChain(picks: boolean[]): number {
  let count = 0
  for (let index = picks.length - 1; index >= 0 && picks[index]; index -= 1) count += 1
  return count
}

/** Longest streak of consecutive successes anywhere in the pick list. */
function bestChainIn(picks: boolean[]): number {
  let best = 0
  let current = 0
  for (const pick of picks) {
    current = pick ? current + 1 : 0
    best = Math.max(best, current)
  }
  return best
}

function playerSide(startPly: number): 'w' | 'b' {
  return startPly % 2 === 0 ? 'w' : 'b'
}

function App() {
  const [store, setStore] = useState<Store>(loadStore)
  const [profileId, setProfileId] = useState<string | null>(store.activeProfileId)
  const profile = store.profiles.find((candidate) => candidate.id === profileId) ?? null
  const [showProfiles, setShowProfiles] = useState(!profile)
  const [run, setRun] = useState<RunState | null>(null)
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [feedback, setFeedback] = useState<RunFeedback | null>(null)
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

  /** Opens a profile and restores exactly where that player left off. */
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

  // Persist the run (game, line, picks, everything) after every change.
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
   * Plays the opponent's reply with the engine. The top move usually answers;
   * when a lower line is nearly equal, one of the close lines is picked at
   * random so the opponent is not perfectly predictable.
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
        const gameOver = new Chess(applied.fenAfter).isGameOver()
        return { ...current, line, movesUci, lineIndex: line.length - 1, done: gameOver }
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
    void engine.analyzePosition(fenBefore, { depth: 16, multipv: 3, maxTimeMs: profile.settings.engineTimeMs })
      .then((result) => {
        setRootAnalysis(result)
        const { san, fenAfter } = applyMove(fenBefore, uci)
        const topMoves = result.lines.slice(0, 3)
        const success = topMoves.some((line) => line.move === uci)

        // The played line up to and including this move (rewinds included).
        const movesUci = [...run.movesUci.slice(0, run.lineIndex), uci]
        const line = [...run.line.slice(0, run.lineIndex + 1), fenAfter]
        const picksBefore = Math.floor((run.lineIndex + 1) / 2)
        const picks = [...run.picks.slice(0, picksBefore), success]
        const chainAfter = trailingChain(picks)
        const achieved = bestChainIn(picks) >= GOAL_CHAIN
        const achievedBefore = bestChainIn(run.picks) >= GOAL_CHAIN

        const nextRun: RunState = { ...run, line, movesUci, lineIndex: line.length - 1, picks }
        setRun(nextRun)

        setFeedback({
          success,
          played: san,
          best: sanFor(fenBefore, topMoves[0]?.move ?? uci) ?? '—',
          opponentReply: undefined,
          chain: chainAfter,
          topMoves: topMoves.map((engineLine) => ({ san: sanFor(fenBefore, engineLine.move) ?? engineLine.move, score: formatScore(engineLine) })),
        })

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

  const ideas = describePosition(run.line[run.lineIndex])
  const startFen = fenAfterMoves(run.game.moves, run.startPly)
  const chain = trailingChain(run.picks)
  const blunders = run.picks.filter((pick) => !pick).length
  const achieved = bestChainIn(run.picks) >= GOAL_CHAIN
  const isPlayerTurn = game!.turn() === playerSide(run.startPly)
  const showNextGame = achieved || run.done
  const thinkLabel = `${(profile.settings.engineTimeMs / 1000).toFixed(0)}s`

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">♞</div>
        <div><p className="eyebrow">NO-BLUNDER RUN</p><h1>Stay in the top 3.</h1></div>
        <div className="streak"><span>◒</span> {profile.streak.current > 0 ? `${profile.streak.current} day streak` : 'Start a streak'}</div>
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
                  ? 'Pick the best move. Top 3 keeps the run alive.'
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
            <button className="think-button" onClick={cycleThinkTime} title="Engine think time per move">◉ {thinkLabel}</button>
          </div>
        </div>

        <aside className="insight-panel">
          <div className="panel-label">TRAINING AS {profile.name.toUpperCase()}</div>
          <h3>{achieved ? 'Run complete. Keep playing or move on.' : 'How long can you stay in the top 3?'}</h3>
          {!feedback ? <ul className="idea-list">{(ideas.length ? ideas : ['Ask what your opponent wants before you choose']).map((idea) => <li key={idea}><span>✦</span>{idea}</li>)}</ul> : null}

          {feedback
            ? <RunFeedbackCard feedback={feedback} opponentThinking={opponentThinking} />
            : <div className="thinking-note"><span className="note-icon">◎</span><div><strong>{isAnalyzing ? 'Reading the position…' : 'Take your time'}</strong><p>{isAnalyzing ? `Berserk is checking the top 3 (${thinkLabel}).` : 'Every pick is judged against the engine’s top 3 moves.'}</p></div></div>}

          {rootAnalysis && <EnginePanel analysis={rootAnalysis} selectedEngineLine={selectedEngineLine} onSelect={setSelectedEngineLine} />}

          {showNextGame && <button className="next-button" onClick={nextGameRun}>Next game <span>→</span></button>}
          {!showNextGame && (
            <button className="skip-button" onClick={() => {
              startRun(profile.id, run.game, run.startPly, run.phase, profile.cursor - 1)
              setFeedback(null)
              setRootAnalysis(null)
            }}>Restart game</button>
          )}
        </aside>
      </section>

      <footer className="app-footer"><span>GOAL: {GOAL_CHAIN} TOP-3 PICKS IN A ROW</span><span>{isAnalyzing || opponentThinking ? 'Engine: analyzing' : 'Engine: Berserk WASM'}</span></footer>
    </main>
  )
}

/** Margin (centipawns) within which the opponent may pick a non-top move at random. */
const REPLY_MARGIN_CP = 30

/** Top engine move, or a random pick among near-equal alternatives. */
function pickEngineReply(lines: EngineAnalysisLine[]): string | undefined {
  if (!lines.length) return undefined
  const value = (line: EngineAnalysisLine) => (line.mateIn !== undefined ? 10_000 - Math.abs(line.mateIn) : line.scoreCp ?? 0)
  const best = value(lines[0])
  const candidates = lines.filter((line) => best - value(line) <= REPLY_MARGIN_CP)
  const chosen = candidates[Math.floor(Math.random() * candidates.length)]
  return (chosen ?? lines[0]).move
}

function gameResultText(run: RunState, achieved: boolean, fen: string): string {
  const chess = new Chess(fen)
  let outcome: string
  if (chess.isCheckmate()) outcome = `Checkmate — ${chess.turn() === 'w' ? 'Black' : 'White'} wins`
  else if (chess.isDraw() || chess.isStalemate()) outcome = 'Drawn'
  else outcome = 'Game stopped'
  const reached = achieved ? 'You completed the run — 3 top-3 picks in a row.' : `Your best run this game: ${bestChainIn(run.picks)} in a row.`
  return `${outcome} · ${reached}`
}

function RunFeedbackCard({ feedback, opponentThinking }: { feedback: RunFeedback; opponentThinking: boolean }) {
  return <div className="feedback-card">
    <div className="result-heading">
      <span className={`result-check ${feedback.success ? '' : 'fail'}`}>{feedback.success ? '✓' : '✕'}</span>
      <div>
        <span className="result-label">{feedback.success ? `TOP 3 · RUN ${feedback.chain}` : 'BLUNDER · RUN RESET'}</span>
        <h3>{feedback.success ? `${feedback.played} keeps the run alive` : `${feedback.played} drops out of the top 3`}</h3>
      </div>
    </div>
    <p>
      {feedback.success
        ? feedback.played === feedback.best
          ? 'That was the engine’s first choice.'
          : `One of the top 3 — the engine's first choice was ${feedback.best}.`
        : `The engine preferred ${feedback.best}.`}</p>
    <div className="move-ideas">
      <span>ENGINE TOP 3</span>
      {feedback.topMoves.map((line, index) => <div key={`${line.san}-${index}`} className={line.san === feedback.played ? 'chosen-move' : ''}>{index + 1}. {line.san} <em>{line.score}</em></div>)}
    </div>
    {feedback.opponentReply || opponentThinking ? <div className="opponent-idea"><span className="lesson-label">OPPONENT</span><p>{opponentThinking && !feedback.opponentReply ? 'Choosing a reply…' : <>Their reply: <b>{feedback.opponentReply}</b></>}</p></div> : null}
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
        <span>{formatScore(line)}</span>
        {selectedEngineLine === line.move ? <small>{formatPv(analysis.fen, line.pv)}</small> : null}
      </button>
    ))}
  </div>
}

function formatScore(line: EngineAnalysisLine) {
  if (line.mateIn !== undefined) return `M${line.mateIn > 0 ? '+' : ''}${line.mateIn}`
  if (line.scoreCp === undefined) return '—'
  return `${line.scoreCp >= 0 ? '+' : ''}${(line.scoreCp / 100).toFixed(2)}`
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
