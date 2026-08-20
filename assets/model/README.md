# Hand landmarker model parts

`hand_landmarker.task` is stored as numbered 64 KiB parts so the public repository remains
portable across constrained Git transports. `npm run prepare:assets` concatenates the parts in
lexicographic order and verifies the reconstructed model against the pinned SHA-256 in
`public/wasm/manifest.json` before a build can continue.

The generated `public/models/hand_landmarker.task` is ignored by Git but included in the Pages
artifact. Browser clients therefore load the complete model from the same GitHub Pages origin.
