# Parallel Universe Vector Capture

A browser-local hand capture tool for producing source-frame metadata for the Parallel Universe
vector-frame compositor. The site is a static React/Vite application: camera frames, imported
videos, landmarks, and trajectories stay in the current browser session and are never uploaded.

## Local development

```bash
npm install
npm run verify:assets
npm run dev
```

Open the HTTPS origin provided by your dev proxy (or use `npm run dev -- --host` behind a local
HTTPS proxy) before granting camera access. `npm run check` runs TypeScript, unit tests, and the
production build.

## Supported output

The standard download contains `manifest.json`, strict Skill-compatible `semantic_tracks.json`,
extended fingertip/palm tracks, CSV rows, geometry hints, and a local README. A diagnostic package
adds raw landmarks, quality events, and the optional local WebM recording. Real-time output is
labelled `presentation_time_estimate`; only imported or post-recording source-frame processing is
labelled `exact_source_frames`.

The semantic contract is deliberately strict: `0` points before tracking, `4` during the confirmed
two-hand pinch phase, and `10` only after both hands are fully open. Partial finger observations
remain in the extended files and are never silently promoted to portal points.

## GitHub Pages

The workflow in `.github/workflows/pages.yml` builds and deploys the `dist` directory. It expects
the repository to be named `parallel-universe-vector-capture` (or uses `GITHUB_REPOSITORY` to set
the Pages subpath). No backend, analytics, cookies, account system, or upload endpoint is part of
this project.

## Privacy

See [`PRIVACY.md`](PRIVACY.md). Camera permission is requested only after an explicit action and
microphone capture is disabled by default.
