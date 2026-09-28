# Curated chess corpus

`games.json` is a 10,000-game sample of standard rated games from the
[Lichess Open Database](https://database.lichess.org), distributed under CC0.
The sample is filtered to games with both players rated at least 1900 and a
minimum of 60 plies. It stores only IDs, player names, and opening labels; no
continuations are sent to the browser. The full PGN source stays under the
repository's local `data/` directory for offline mining and is not copied into
Vite's public output. Regenerate with `bun run curate:games -- 2026-08 10000
40000000` (or increase the compressed-prefix byte count if needed).

`decision-points.json` stores only the game ID, start ply/FEN, preceding move,
phase, and interest score. It is generated offline using the project's
bundled Berserk WASM engine and NNUE network. Opening candidates are filtered
for a score of at least 10, favoring clear move gaps, forcing tactics, and
recorded-game mistakes over routine book positions. The app selects from each
phase's top 30%, weighted 20% opening, 55% middlegame, and 25% endgame.
Regenerate with `bun run mine:positions` after curating a new corpus.

These static assets are fetched at runtime; they are not imported into the
application JavaScript bundle. If either asset is unavailable, the app falls
back to the small bundled sample and its phase-based position selector.
