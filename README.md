# VIBER BRAWL — online multiplayer

Two files plus the manifest Render needs.

| File | What it is |
|---|---|
| `vibe-brawl.html` | The game, with multiplayer built in |
| `vibe-brawl-server.js` | The referee: rooms, lobbies, matchmaking, physics |
| `package.json` | Tells Render how to install and start |
| `render.yaml` | Optional: lets Render configure itself |

Deploy settings, if you are filling them in by hand:

- Build Command: `npm install`
- Start Command: `node vibe-brawl-server.js`
- Instance Type: `Free`
