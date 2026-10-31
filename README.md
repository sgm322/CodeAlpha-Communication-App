# Yappuccino

A small, Figma-inspired meeting place for video calls, screen sharing, shared files, and a live collaborative whiteboard.

## Run locally

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Run `npm start`.
4. Open the URL printed in the terminal and create an account. By default, the app tries ports 3000–3010 and picks the first available one.

To select a specific port, set `PORT` before starting, for example in PowerShell: `$env:PORT=3178; npm start`. If that port is already in use, the server reports the conflict instead of choosing a different port.

For a call with another person, both people should open the same room link while the app server is running. Camera and microphone access work on `localhost`; other deployments need HTTPS.

## Features

- Email and password sign-up/sign-in. Passwords are salted and hashed with Node.js `scrypt`.
- Socket.IO rooms for presence, WebRTC offer/answer/ICE signaling, and whiteboard updates.
- Peer-to-peer media calls using WebRTC, including screen sharing. WebRTC encrypts media with DTLS-SRTP.
- Shared whiteboard with drawing colors, an eraser, and synchronized clear/drawing actions.
- Authenticated room file sharing and downloads (up to 10 MB per file).
- Responsive layout with a playful purple palette.

## Deployment and security notes

Set a long, random `APP_SECRET` in the server environment and keep it stable between restarts; otherwise existing sign-in tokens will stop working. Put the app behind an HTTPS reverse proxy for non-local use. HTTPS protects sign-in, signaling, and file transfers in transit; only WebRTC media is encrypted peer-to-peer by the browser. Shared files and account records are stored on the server's local disk and are **not encrypted at rest**.

The included JSON-backed account and file indexes are intended for a small, single-process demo. Use a managed database, private object storage, backups, rate limiting, and operational monitoring before production deployment.
