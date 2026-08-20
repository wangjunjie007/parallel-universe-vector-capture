# Hand landmarker model parts

`hand_landmarker.task` is stored as numbered 64 KiB parts so the public repository remains
portable across constrained Git transports. `npm run prepare:assets` concatenates the parts in
lexicographic order and verifies the reconstructed model against the pinned SHA-256 in
`public/wasm/manifest.json` before a build can continue.

The generated `public/models/hand_landmarker.task` is ignored by Git but included in the Pages
artifact. Browser clients therefore load the complete model from the same GitHub Pages origin.

Upstream model card and source:

- https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
- https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf
- https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

The model card documents the model's intended uses and states that its documentation is Apache
2.0; it does not provide a separate binary-model license. See the repository-level `NOTICE` for
the redistribution boundary.
