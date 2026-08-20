# Privacy

This application processes camera frames and selected local video in your browser. It does not
send frames, video, landmarks, trajectories, or generated packages to a server. Clearing the
session stops media tracks and revokes in-memory object URLs.

The browser may show its normal permission prompt and GitHub Pages may receive ordinary hosting
access logs. The application does not add analytics, advertising trackers, cookies, WebSockets,
accounts, or a cloud storage service. Microphone capture is not requested by the application.

Downloaded files are written by your browser to a location you choose. Check the exported manifest
before sharing it: it contains source dimensions, timing, model hashes, and quality diagnostics,
but intentionally omits local absolute paths, device IDs, camera names, and credentials.
