# Chess Position Trainer

Mobile-first Vite/React/TypeScript prototype for training chess plans instead
of opening memorization.

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

## Current slice

- Responsive training screen using `react-chessboard`.
- Legal move validation and move application through `chess.js`.
- Best Move exercise flow with practical, non-binary feedback.
- Explainable position cues for development and central play.
- Starter exercise data model with two initial positions.
- `EngineAdapter` boundary ready for the Berserk WASM Worker.

The current adapter is intentionally a demo adapter. It provides the stable
application boundary while the Berserk fork is connected through a Worker.
Training logic should remain independent of the engine implementation.
