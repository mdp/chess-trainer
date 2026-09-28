# Chess Trainer — No-Blunder Run

Mobile-first Vite/React/TypeScript trainer built on real games. You solve
pre-mined decision points; Berserk grades moves by expected-score loss, and
mistakes let you retry from the same position with progressive hints. The goal
is three sound decisions in a row; you can navigate the resulting line at any
time.

## Run with Bun

```bash
bun install
bun run dev
```

Build and preview the production bundle:

```bash
bun run build
bun run preview
```

## Data (all client-side, no backend)

- `public/data/games.json` — 10,000 real rated games curated from the
  [Lichess open database](https://database.lichess.org) (CC0), both players
  rated ≥1900 and at least 60 plies. It contains only display metadata—no game
  continuations—and is fetched as a static asset, not bundled with the JavaScript.
- `public/data/decision-points.json` stores only the selected start FEN,
  preceding-move highlight, game ID, phase, and interest score per position.
  The full source PGN under `data/games.pgn` is used offline for mining only;
  it is not served to the app. `src/data/games.pgn` remains the small fallback.
- Regenerate the corpus with `bun run curate:games -- [YYYY-MM] [count] [compressedBytes]`
  and mine it with `bun run mine:positions -- [data/games.pgn] [decision-points.json] [positionsPerGame] [thinkMs]`.
- `src/data/openings.tsv` — ECO openings from
  [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0).
- Personal-game importing/sync is intentionally not part of the app; training
  uses the shared public corpus above.

## Game loop

1. Each game starts at a pre-analyzed decision point from a real game; the
   corpus includes quality-filtered opening, middlegame, and endgame positions.
2. You play the side to move; engine replies are selected from near-equal lines.
3. Berserk judges your move with MultiPV 5 and converts centipawns to expected
   score, with centipawn-loss guardrails so a large raw eval drop cannot hide
   behind a winning position. Excellent and Good are green; Inaccuracy is an
   amber warning that continues the chain; Mistake and Blunder return you to
   the same position to retry.
4. Retry hints progress from none, to candidate squares, to top-move names.
   After three misses you can reveal the best move and continue.
5. Reach 3 sound decisions in a row → "Next game". You can keep playing the
   current game to the end, or navigate backward and forward through its line.

## Persistence

Everything lives in `localStorage` per profile: streaks (real calendar dates),
runs achieved, best run, the current game/line/picks, and engine think time.
Multiple local profiles are supported. Legacy cached personal-game PGNs are
removed when an older store is loaded.
