# SemanticStream

**Less data. More understanding.**

SemanticStream is an adaptive context streaming infrastructure for real-time AI agents. It selects context from a continuous stream under constrained bandwidth and compute. The project aims to let agents explicitly retrieve original context when needed.

Phase 0 is a browser-only visual demo. A procedural Canvas cycles through a still scene, slow movement, fast movement, and a brief text event. Fixed-rate and adaptive policies see the same captured frames and feed independent mock-agent views. The app shows the original input, the selected mock agent's latest frame, and live metrics from both strategies. All visual processing runs locally. The demo requires no GPU, backend, database, or model API.

## Run locally

Use Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. Change the sampling mode to inspect either agent's view. Use the sliders to adjust the adaptive pixel threshold or the rolling frame cap for both strategies. Restart replays the scene from the beginning and clears the counts while preserving control settings.

## Verify and build

```sh
npm run typecheck
npm run test
npm run build
npm run preview
```

GitHub Actions runs the install, typecheck, tests, and static build for branch pushes and pull requests. For Cloudflare Pages, use the Vite preset or set the build command to `npm run build`, the build output directory to `dist`, and `NODE_VERSION` to `24`. The application uses static files and requires no Cloudflare bindings.

## Read the results

Fixed mode targets 4 fps. Adaptive mode uses mean RGB change against its latest accepted frame. Both apply 125 ms minimum delivery spacing, a 1.5 s silence refresh when capacity permits, and the configured rolling five-second cap.

The dashboard reports processed input frames, actual frame deliveries, the filtered share, and mean browser processing latency. Brief or small visual events can be missed by capture, sampling, or the budget. Raw-frame retrieval remains planned. The frame metrics do not measure model tokens.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for contracts and timing, [ROADMAP.md](ROADMAP.md) for follow-up work, and [AGENTS.md](AGENTS.md) for coding-agent handoff.

## License

Apache License 2.0 is proposed for SemanticStream, pending repository owner confirmation. The repository currently has no project license file.
