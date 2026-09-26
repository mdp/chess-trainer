# Chess Trainer — No-Blunder Run

Mobile-first Vite/React/TypeScript trainer built on real games. You play one
side of a real rated game; every pick is judged against Berserk's (WASM) top 3
moves. Goal: three top-3 picks in a row per game. A blunder resets the run but
the game keeps going — you can navigate back and forward at any time.

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

- `src/data/games.pgn` — 260 real rated games curated from the
  [Lichess open database](https://database.lichess.org) (CC0) by
  `scripts/curate-games.mjs` (both players ≥ 1900, ≥ 60 plies).
  Regenerate with `bun scripts/curate-games.mjs [YYYY-MM] [count]`.
- `src/data/openings.tsv` — ECO openings from
  [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0).
- Optional: sync any Lichess player's recent rated games straight from the
  Lichess API in the browser (CORS-enabled) and cached per profile.

## Game loop

1. Each game starts from a phase-tagged position (mostly middlegame, some
   opening, occasional endgame) from a real game.
2. You play one side; the opponent's moves come from the game record. If you
   deviate (with a different top-3 move), the engine answers instead.
3. Berserk analyzes each position you face (MultiPV 3, configurable think
   time — default 2 s, tap ◉ in the footer to change).
4. Your move in the top 3 → run continues. Outside the top 3 → blunder, the
   run resets, and the engine shows what it preferred.
5. Reach 3 in a row → "Next game". You can always keep playing the current
   game to the end, backward and forward.

## Persistence

Everything lives in `localStorage` per profile: streaks (real calendar dates),
runs achieved, best run, the current game/line/picks, engine think time, and
synced games. Multiple local profiles are supported.
