import { useMemo, useState } from 'react'
import { Chess, type Square } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { classifyEngineMove, createEngineAdapter, type EngineAnalysis, type EngineAnalysisLine } from './engineAdapter'
import { starterExercises } from './exercises'
import { describePosition } from './positionAnalysis'
import { classifyOpening } from './openingClassifier'
import type { Exercise, MoveFeedback } from './types'

const INITIAL_INDEX = 1

function App() {
  const [exerciseIndex, setExerciseIndex] = useState(INITIAL_INDEX)
  const [exercise, setExercise] = useState<Exercise>(starterExercises[INITIAL_INDEX])
  const [line, setLine] = useState<string[]>([exercise.fen])
  const [lineIndex, setLineIndex] = useState(0)
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [feedback, setFeedback] = useState<MoveFeedback | null>(null)
  const [rootAnalysis, setRootAnalysis] = useState<EngineAnalysis | null>(null)
  const [analysis, setAnalysis] = useState<EngineAnalysis | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [selectedEngineLine, setSelectedEngineLine] = useState<string[] | null>(null)

  const game = useMemo(() => new Chess(line[lineIndex]), [line, lineIndex])
  const positionIdeas = useMemo(() => describePosition(exercise.fen), [exercise.fen])
  const openingContext = useMemo(() => classifyOpening(exercise), [exercise])
  const engine = useMemo(() => createEngineAdapter(), [])
  const isExploring = feedback !== null

  function resetExercise(nextIndex = exerciseIndex) {
    const next = starterExercises[nextIndex]
    setExercise(next)
    setLine([next.fen])
    setLineIndex(0)
    setSelectedSquare(null)
    setFeedback(null)
    setRootAnalysis(null)
    setAnalysis(null)
    setSelectedEngineLine(null)
    setIsAnalyzing(false)
  }

  function analyze(fen: string, callback?: (result: EngineAnalysis) => void) {
    setIsAnalyzing(true)
    void engine.analyzePosition(fen, { depth: 14, multipv: 3, maxTimeMs: 1200 })
      .then((result) => {
        setAnalysis(result)
        callback?.(result)
      })
      .catch(() => setAnalysis({ fen, lines: [] }))
      .finally(() => setIsAnalyzing(false))
  }

  function commitMove(sourceSquare: Square, targetSquare: Square) {
    if (isAnalyzing) return false
    const positionBeforeMove = game.fen()
    const nextGame = new Chess(positionBeforeMove)
    try {
      const move = nextGame.move({ from: sourceSquare, to: targetSquare, promotion: 'q' })
      if (!move) return false
      const nextFen = nextGame.fen()
      const nextLine = [...line.slice(0, lineIndex + 1), nextFen]
      setLine(nextLine)
      setLineIndex(nextLine.length - 1)
      setSelectedSquare(null)

      if (!isExploring) {
        analyze(positionBeforeMove, (result) => {
          setRootAnalysis(result)
          setFeedback(classifyEngineMove(`${sourceSquare}${targetSquare}`, move.san, result, exercise.suggestedMoves))
        })
      } else {
        analyze(nextFen)
      }
      return true
    } catch {
      return false
    }
  }

  function onSquareClick(square: string) {
    if (isAnalyzing) return
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
    if (!commitMove(selectedSquare, clicked) && piece?.color === game.turn()) setSelectedSquare(clicked)
  }

  function chooseEngineLine(pv: string[]) {
    setLine([exercise.fen])
    setLineIndex(0)
    setSelectedSquare(null)
    setSelectedEngineLine(pv)
    setAnalysis(rootAnalysis)
  }

  function goBack() {
    if (lineIndex === 0 || isAnalyzing) return
    const nextIndex = lineIndex - 1
    setLineIndex(nextIndex)
    setSelectedSquare(null)
    setSelectedEngineLine(null)
    analyze(line[nextIndex])
  }

  function goForward() {
    if (lineIndex >= line.length - 1 || isAnalyzing) return
    const nextIndex = lineIndex + 1
    setLineIndex(nextIndex)
    setSelectedSquare(null)
    analyze(line[nextIndex])
  }

  function nextExercise() {
    const nextIndex = (exerciseIndex + 1) % starterExercises.length
    setExerciseIndex(nextIndex)
    resetExercise(nextIndex)
  }

  const currentAnalysis = analysis ?? rootAnalysis

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">♞</div>
        <div><p className="eyebrow">POSITION TRAINER</p><h1>Think in plans.</h1></div>
        <div className="streak"><span>◒</span> 3 day streak</div>
      </header>

      <section className="training-layout">
        <div className="board-column">
          <div className="exercise-meta">
            <div><span className="mode-pill">BEST MOVE</span><span className="exercise-count">Exercise {exerciseIndex + 1} of {starterExercises.length}</span></div>
            <button className="icon-button" aria-label="Settings">☷</button>
          </div>

          <div className="prompt-card">
            <span className="prompt-kicker">{isExploring ? 'ANALYSIS BOARD' : 'THE QUESTION'}</span>
            <h2>{isExploring ? 'Now explore the position yourself.' : exercise.prompt}</h2>
            {!isExploring && <p>Ignore the opening name. Read the position in front of you.</p>}
            {isExploring && <p>Click a piece, then click its destination.</p>}
          </div>

          <div className="board-wrap">
            <Chessboard options={{
              position: game.fen(),
              onSquareClick: ({ square }) => onSquareClick(square),
              boardOrientation: exercise.sideToMove,
              allowDragging: false,
              squareStyles: selectedSquare ? { [selectedSquare]: { boxShadow: 'inset 0 0 0 4px rgba(166, 214, 200, .9)' } } : {},
              animationDurationInMs: 180,
              boardStyle: { borderRadius: '12px', overflow: 'hidden' },
              darkSquareStyle: { backgroundColor: '#52748a' },
              lightSquareStyle: { backgroundColor: '#dce8e3' },
            }} />
          </div>

          <div className="board-footer">
            <span><i className="turn-dot" /> {game.turn() === 'w' ? 'White' : 'Black'} to move</span>
            <div className="line-controls">
              {isExploring && <button onClick={goBack} disabled={lineIndex === 0 || isAnalyzing}>← Back</button>}
              {isExploring && <span>{lineIndex} / {line.length - 1}</span>}
              {isExploring && <button onClick={goForward} disabled={lineIndex >= line.length - 1 || isAnalyzing}>Forward →</button>}
            </div>
            <label className="history-toggle"><input type="checkbox" checked={showHistory} onChange={(event) => setShowHistory(event.target.checked)} /> Show history</label>
          </div>
        </div>

        <aside className="insight-panel">
          <div className="panel-label">{isExploring ? 'ENGINE WINDOW' : 'POSITION READ'}</div>
          <h3>{isExploring ? 'Compare ideas, then try them yourself.' : 'What is this position asking for?'}</h3>
          {!isExploring ? <ul className="idea-list">{(positionIdeas.length ? positionIdeas : ['Find the piece or king-safety move that improves your position']).map((idea) => <li key={idea}><span>✦</span>{idea}</li>)}</ul> : null}

          {!feedback ? <div className="thinking-note"><span className="note-icon">◎</span><div><strong>{isAnalyzing ? 'Reading the position…' : 'Take your time'}</strong><p>{isAnalyzing ? 'Comparing your move with the best practical alternatives.' : 'Speed is not the lesson. Make a plan before you make a move.'}</p></div></div> : <><FeedbackCard feedback={feedback} explanation={exercise.explanation} analysis={rootAnalysis} onChooseLine={chooseEngineLine} />{openingContext && <OpeningContextCard context={openingContext} />}</>}

          {isExploring && <EnginePanel analysis={currentAnalysis} selectedEngineLine={selectedEngineLine} onChooseLine={chooseEngineLine} />}
          {feedback && <button className="next-button" onClick={nextExercise}>Next position <span>→</span></button>}
          {!feedback && <button className="skip-button" onClick={() => resetExercise()}>Reset position</button>}
        </aside>
      </section>

      <footer className="app-footer"><span>TRAIN THE IDEA, NOT THE MOVE</span><span>{isAnalyzing ? 'Engine: analyzing' : 'Engine: Berserk WASM'}</span></footer>
    </main>
  )
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

function EnginePanel({ analysis, selectedEngineLine, onChooseLine }: { analysis: EngineAnalysis | null; selectedEngineLine: string[] | null; onChooseLine: (pv: string[]) => void }) {
  if (!analysis || !analysis.lines.length) return <div className="engine-loading">No engine lines available yet.</div>
  return <div className="engine-panel"><div className="engine-panel-heading"><span>TOP ENGINE IDEAS</span><small>from this position</small></div>{analysis.lines.slice(0, 3).map((line, index) => <button className={`engine-line ${selectedEngineLine?.[0] === line.move ? 'chosen' : ''}`} key={`${line.move}-${index}`} onClick={() => onChooseLine(line.pv ?? [line.move])}><strong>{index + 1}</strong><b>{lineLabel(analysis.fen, line)}</b><span>{formatScore(line)}</span><small>{formatPv(analysis.fen, line.pv)}</small></button>)}<p className="engine-hint">These are suggestions, not commands. Select a line to return to the original position, then play it yourself.</p></div>
}

function OpeningContextCard({ context }: { context: NonNullable<ReturnType<typeof classifyOpening>> }) {
  return <div className="opening-context"><div className="opening-context-heading"><span className="lesson-label">AFTER THE DECISION</span><span className="confidence-pill">{context.confidence}</span></div><h4>{context.name ?? context.familyName}{context.eco ? <small>{context.eco}</small> : null}</h4><p>This position is {context.confidence === 'exact' ? 'from' : 'similar to'} the {context.familyName}. You did not need the name to find the useful idea.</p>{context.themes.length ? <div className="opening-themes">{context.themes.slice(0, 4).map((theme) => <span key={theme}>{theme}</span>)}</div> : null}</div>
}

function formatPv(fen: string, pv?: string[]) {
  if (!pv?.length) return 'No continuation returned'
  try {
    const chess = new Chess(fen)
    return pv.slice(0, 5).map((uci) => {
      const move = chess.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined })
      return move?.san ?? uci
    }).join(' ')
  } catch { return pv.slice(0, 5).join(' ') }
}

function FeedbackCard({ feedback, explanation, analysis, onChooseLine }: { feedback: MoveFeedback; explanation: string; analysis: EngineAnalysis | null; onChooseLine: (pv: string[]) => void }) {
  return <div className="feedback-card"><div className="result-heading"><span className="result-check">✓</span><div><span className="result-label">{feedback.label}</span><h3>{feedback.title}</h3></div></div><p>{feedback.body}</p><div className="move-ideas"><span>WHAT IT DOES</span>{feedback.ideas.map((idea) => <div key={idea}>✓ {idea}</div>)}</div>{analysis?.lines.length ? <div className="alternatives"><span className="lesson-label">WHAT ELSE COULD YOU HAVE PLAYED?</span>{analysis.lines.slice(0, 3).map((line, index) => <button key={line.move} onClick={() => onChooseLine(line.pv ?? [line.move])}><b>{index + 1}. {lineLabel(analysis.fen, line)}</b><em>{formatScore(line)}</em></button>)}</div> : null}<div className="lesson"><span className="lesson-label">POSITION IDEA</span><p>{explanation}</p></div></div>
}

export default App
