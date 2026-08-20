# Export schemas

These schemas describe the files emitted by the browser export. They are JSON Schema
Draft 2020-12 documents and are intentionally kept separate from the runtime so the offline
compositor can validate a package without loading the web application.

- `semantic_tracks.schema.json` is the strict Skill adapter contract. Its `count` values are only
  `0`, `4`, and `10`.
- `fingertip_tracks.schema.json` is the extended trajectory layer. Long gaps use explicit `null`
  coordinates and `missing: true`; they are never filled with fabricated positions.
- `palm_tracks.schema.json` contains one time sample per hand per represented source frame.
- `geometry-hint.schema.json` describes preview hints only. The offline compositor remains the
  authority for final portal faces.
- `manifest.schema.json` records model hashes, source geometry, alignment, quality, and local-only
  privacy flags without device identifiers or absolute paths.
