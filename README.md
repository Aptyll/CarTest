# Lowpoly Rocket League 1v1

A tiny vanilla JavaScript three.js prototype with PeerJS multiplayer, host-owned physics, score, boost, jump, and arena power-ups.

## Run Locally

1. Open this folder in Cursor or VS Code.
2. Start the page with Live Server.
3. The host clicks **Host Game** and shares:
   - The Live Server URL, for example `http://192.168.1.20:5500`
   - The generated peer room ID
4. The guest opens the same URL, pastes the room ID, and clicks **Join Game**.

PeerJS handles the WebRTC connection between browsers. This prototype uses the public PeerJS signaling broker from the CDN script, while the game page itself is locally hosted from your computer.

## Controls

- `W` / `S`: Drive forward / reverse
- `A` / `D`: Steer
- `Space`: Jump
- `Shift`: Boost

## Arena And Power-Ups

- The arena is larger than the original prototype and uses Rocket League-style boost pad placement near corners, sides, and diagonal midfield lanes.
- Orange pad: full boost refill
- Green crystal: extra jump
- Purple crystal: stronger ball hit pulse
