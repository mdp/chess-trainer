# Chess Trainer: gameplay, game selection, and scoring

## What the game is

Each run gives the player a mined decision point from a real recorded game. The player chooses a move; a chess engine grades it and plays the opponent's reply. The goal is to make **three sound decisions in a row**. Mistakes and blunders keep the player at the same position for a retry; the best completed chain is retained.

The recorded game supplies the starting position and its context (players, ratings, opening, and game ID). After the exercise begins, the trainer does **not** follow the recorded continuation: the opponent replies are chosen by the engine.

## Where the games come from

There is no server-side game database. The trainer uses a shared public corpus:

1. **Public game metadata:** `public/data/games.json` contains 10,000 IDs, player names, and optional opening labels from rated Lichess Open Database games (CC0); it has no move lists.
2. **Mined decisions:** `public/data/decision-points.json` contains a compact record per position: FEN, previous recorded move, game ID, phase, and interest score. Candidate positions were analyzed offline with Berserk WASM/NNUE MultiPV 3. The full PGN at `data/games.pgn` is an offline mining source only and is not served to the browser.

Profiles, settings, and run state are stored in browser `localStorage` under `chess-trainer:store:v2`; they are not shared with a backend. Personal-game Lichess sync/import is not supported, and legacy cached personal PGNs are discarded when the old store is loaded.

## How a game and starting position are selected

- A mined position is selected randomly from the upper 30% of the interestingness ranking. The immediately previous game ID is excluded when there is another option, so a new run or profile reopen does not immediately repeat that game. This is random selection, not a shuffle bag: a game can appear again later.
- Decision positions are sampled across each game's opening, middlegame, and endgame. The selector chooses a phase with weights of 20%, 55%, and 25%, then samples from that phase's top 30% by interest score.
- Phase detection is heuristic. The app replays the game and classifies positions using move number and the number of non-pawn pieces: an early position with many pieces is an opening; six or fewer non-pawn pieces is an endgame; other positions are middlegames.
- The starting position is the exact FEN stored in the pre-analyzed decision index. The index also carries the recorded move immediately before it for the board highlight; no game continuation is downloaded or replayed.
- The player is assigned the side whose turn it is at the selected starting ply. The engine plays the other side.
- Opening a profile starts a fresh random game rather than resuming the saved board; the saved game's ID is excluded when possible. **Restart** replays the current game's same starting position. **Next game** selects another random game.

## Move analysis and approval

The browser runs the Berserk chess engine (WASM with its NNUE network) in a Web Worker. The analysis is local; game positions are not sent to a chess backend.

Before the player moves, the engine analyzes the current position with **MultiPV 5** (up to five candidate moves), depth 16, and the selected think-time limit. The default think time is 2 seconds; the setting cycles through 1, 2, 3, and 5 seconds. Analysis is started when a run opens and again after each engine reply, then cached by position and analysis settings to reduce the wait after the player chooses a move.

The engine's top line is the best candidate. Each line's centipawn score is converted to expected score with a logistic curve, `1 / (1 + exp(-cp / 280))`. The difference between the best move's and played move's expected scores is the expected-score (WDL-style) loss. Grades are Excellent (<4%), Good (<10%), Inaccuracy (<20%), Mistake (<35%), and Blunder (35% or greater). To prevent the curve flattening in already-winning/losing positions from hiding major drops, centipawn losses of 100/200/400 cp set minimum severities of Inaccuracy/Mistake/Blunder. Inaccuracies are shown amber and continue the chain; Mistakes/Blunders do not advance the board and can be retried. If the engine returns no lines, an `engine-unavailable` fallback allows play to continue.

When the played move is absent from MultiPV 5, the app runs a short search from the resulting position and inverts the opponent-to-move score. This rescues reasonable moves outside the initial candidate list instead of automatically rejecting them.

### Retry and hints

- A Mistake or Blunder returns the board to the same position and logs the attempt. First retry: no hint. After the second failed try: candidate source/destination squares are highlighted. After the third: top move names are shown.
- After three failed tries, **Reveal & continue** plays the best move and lets the engine reply. All missed and successful attempts are stored with the eventual pick.
- Evaluations and move names remain hidden until after the player has moved. The engine's cached pre-move analysis is used only to judge that move.

### Evaluation labels and move feedback

- Centipawn scores are displayed as signed pawns to one decimal place, e.g. `+0.4` or `−1.2`. Mate scores are displayed as `M3` or `M−3`. The feedback also displays expected-score loss.
- After a move that does not require a retry, the UI shows the engine's top three suggestions and the played move if it is not among them. For retries, alternatives remain hidden until the third failed attempt.
- The player's move is evaluated from the position before it was played. The history also stores an evaluation label for the engine reply, inverted for the player's perspective.
- The engine opponent analyzes its reply position with depth 12, MultiPV 3, and a 600 ms time limit. It chooses randomly among returned lines within 30 centipawns (0.30 pawns) of the best line; if there are no near-equal alternatives, it plays the best line.

## Run history and progress

The move list starts at the selected exercise position and records moves played during the run, with player-move approval marks and available evaluation labels. Back/Forward controls and clickable history rows navigate the recorded run line. When a new move is played after navigating backward, the later line is replaced.

The run counter shows the current consecutive sound-decision chain (goal: 3). The profile tracks games played, runs achieved, best chain, and a day streak. Progress, each pick grade, and the retry attempts are saved locally in the browser. Selecting **Next game** records the current game as finished/moved on from and starts another random run.

## Relevant implementation files

- `src/App.tsx` — run flow, engine feedback, move history, profiles, and persistence updates.
- `src/gameData.ts` — PGN parsing, phase detection, and fallback game selection.
- `src/decisionPoints.ts` — static corpus/index loading and decision-point selection.
- `public/data/games.json` / `public/data/decision-points.json` — lightweight runtime metadata and position corpus.
- `data/games.pgn` — local-only PGN source used for offline mining; not part of the Vite public assets.
- `scripts/curate-games.mjs` / `scripts/mine-positions.mjs` — corpus generation and offline engine mining.
- `src/engineAdapter.ts` and `src/engine.worker.ts` — browser engine interface and worker.
- `src/grading.ts` — expected-score conversion and five-grade thresholds.
- `src/types.ts` and `src/storage.ts` — grades, attempts, move judgments, and locally persisted profiles/run state.
