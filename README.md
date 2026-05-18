# Lowpoly Rocket League 1v1

A tiny vanilla JavaScript three.js prototype with PeerJS multiplayer, host-owned physics, score, boost, jump, and arena power-ups.

## Run Locally Or On GitHub Pages

1. Open this folder in Cursor or VS Code.
2. Start the page with Live Server, or open the GitHub Pages link.
3. The host clicks **Host Game** and shares the lobby code, for example `CAR-1234`.
4. The guest opens the same game page, pastes the lobby code, and clicks **Join Lobby**.

PeerJS handles the WebRTC connection between browsers. The page URL only gets both players to the same game page; the lobby code connects the guest to the host.

## Controls

- `W` / `S`: Drive forward / reverse
- `A` / `D`: Steer
- `Space`: Jump, then press again quickly in the air to flip
- `W`, `A`, `S`, or `D` + second `Space`: Directional air flip
- `Shift`: Faster boost with orange/blue boost trails

## Arena And Power-Ups

- The arena is larger than the original prototype and uses Rocket League-style boost pad placement near corners, sides, and diagonal midfield lanes.
- Orange pad: full boost refill
- Green crystal: extra jump
- Purple crystal: stronger ball hit pulse
