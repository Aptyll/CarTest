import * as THREE from "https://unpkg.com/three@0.165.0/build/three.module.js";

const FIELD = {
  width: 46,
  depth: 76,
  wall: 3.1,
  goalWidth: 17,
  goalDepth: 5.2,
};

const PLAYER_IDS = ["host", "guest"];
const COLORS = {
  host: 0x46c7ff,
  guest: 0xff9747,
  ball: 0xf7fbff,
  grass: 0x17624d,
  grassAlt: 0x1d745a,
  line: 0xd8fbff,
  blueGoal: 0x42d9ff,
};

const KEYS = {
  KeyW: "throttle",
  KeyS: "brake",
  KeyA: "left",
  KeyD: "right",
  Space: "jump",
  ShiftLeft: "boost",
  ShiftRight: "boost",
};

const menu = document.querySelector("#menu");
const hud = document.querySelector("#hud");
const statusEl = document.querySelector("#status");
const scoreEl = document.querySelector("#score");
const boostBar = document.querySelector("#boostMeter span");
const roomCard = document.querySelector("#roomCard");
const roomIdEl = document.querySelector("#roomId");
const roomInput = document.querySelector("#roomInput");
const hostButton = document.querySelector("#hostButton");
const joinButton = document.querySelector("#joinButton");
const canvas = document.querySelector("#gameCanvas");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07111f);
scene.fog = new THREE.Fog(0x07111f, 62, 142);

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 220);
const clock = new THREE.Clock();
const stateClock = new THREE.Clock();

let role = null;
let peer = null;
let connection = null;
let connected = false;
let latestRemoteState = null;
let lastNetworkSend = 0;
let resetMessageTime = 0;

const input = {
  throttle: false,
  brake: false,
  left: false,
  right: false,
  jump: false,
  boost: false,
};

const trailState = {
  dirtCursor: 0,
  boostCursor: 0,
};

const gameState = createInitialState();
const objects = createWorld();

resize();
renderer.setAnimationLoop(loop);

hostButton.addEventListener("click", startHost);
joinButton.addEventListener("click", joinGame);
window.addEventListener("resize", resize);

window.addEventListener("keydown", (event) => {
  if (KEYS[event.code]) {
    input[KEYS[event.code]] = true;
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  if (KEYS[event.code]) {
    input[KEYS[event.code]] = false;
    event.preventDefault();
  }
});

function startHost() {
  role = "host";
  const lobbyCode = createLobbyCode();
  peer = new Peer(lobbyCode);
  showGame("Creating lobby code...", true);

  peer.on("open", (id) => {
    roomCard.classList.remove("hidden");
    roomIdEl.textContent = id;
    setStatus(`Waiting for guest. Share lobby code ${id}.`);
  });

  peer.on("connection", (conn) => {
    if (connection) {
      conn.close();
      return;
    }
    attachConnection(conn);
    menu.classList.add("hidden");
    setStatus("Guest connected. You are blue.");
  });

  peer.on("error", (error) => {
    if (error.type === "unavailable-id") {
      setStatus("That lobby code was taken. Refresh and host again for a new code.");
      return;
    }
    setStatus(`Peer error: ${error.message}`);
  });
}

function joinGame() {
  const lobbyCode = roomInput.value.trim().toUpperCase();
  if (!lobbyCode) {
    setStatus("Enter the host's lobby code first.");
    return;
  }

  role = "guest";
  peer = new Peer();
  showGame(`Joining lobby ${lobbyCode}...`);

  peer.on("open", () => {
    attachConnection(peer.connect(lobbyCode, { reliable: true }));
  });

  peer.on("error", (error) => setStatus(`Peer error: ${error.message}`));
}

function attachConnection(conn) {
  connection = conn;

  conn.on("open", () => {
    connected = true;
    setStatus(role === "host" ? "Guest connected. You are blue." : "Connected. You are orange.");
    conn.send({ type: "hello", role });
  });

  conn.on("data", (message) => {
    if (!message || typeof message !== "object") return;

    if (role === "host" && message.type === "input") {
      gameState.players.guest.input = message.input;
    }

    if (role === "guest" && message.type === "state") {
      latestRemoteState = message.state;
      copyNetworkState(gameState, latestRemoteState);
    }
  });

  conn.on("close", () => {
    connected = false;
    setStatus("Peer disconnected. Refresh to start a new room.");
  });

  conn.on("error", (error) => setStatus(`Connection error: ${error.message}`));
}

function showGame(message, keepMenu = false) {
  menu.classList.toggle("hidden", !keepMenu);
  hud.classList.remove("hidden");
  setStatus(message);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function createLobbyCode() {
  return `CAR-${Math.floor(1000 + Math.random() * 9000)}`;
}

function loop() {
  const frameDt = Math.min(clock.getDelta(), 0.033);
  const localId = role || "host";

  if (role === "host") {
    gameState.players.host.input = { ...input };
    updateSimulation(gameState, frameDt);
    sendState();
  } else if (role === "guest") {
    sendInput();
    if (!latestRemoteState) {
      gameState.players.guest.input = { ...input };
      updateGuestPreview(gameState, frameDt);
    }
  } else {
    updateAttractMode(gameState, frameDt);
  }

  updateMeshes(gameState);
  updateCamera(localId, frameDt);
  updateHud(localId);
  renderer.render(scene, camera);
}

function sendInput() {
  if (!connected || !connection?.open) return;

  const elapsed = stateClock.elapsedTime;
  if (elapsed - lastNetworkSend < 1 / 30) return;
  lastNetworkSend = elapsed;
  connection.send({ type: "input", input: { ...input } });
}

function sendState() {
  if (!connected || !connection?.open) return;

  const elapsed = stateClock.elapsedTime;
  if (elapsed - lastNetworkSend < 1 / 24) return;
  lastNetworkSend = elapsed;
  connection.send({ type: "state", state: serializeState(gameState) });
}

function createInitialState() {
  return {
    players: {
      host: createPlayer("host", 0, 25, Math.PI),
      guest: createPlayer("guest", 0, -25, 0),
    },
    ball: {
      position: { x: 0, y: 1.15, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      radius: 1.15,
    },
    score: { host: 0, guest: 0 },
    powerups: [
      createPowerup("boost", -17, -29),
      createPowerup("boost", 17, -29),
      createPowerup("boost", -17, 29),
      createPowerup("boost", 17, 29),
      createPowerup("boost", -19, 0),
      createPowerup("boost", 19, 0),
      createPowerup("boost", -10, -15),
      createPowerup("boost", 10, -15),
      createPowerup("boost", -10, 15),
      createPowerup("boost", 10, 15),
      createPowerup("jump", -6, 0),
      createPowerup("pulse", 6, 0),
    ],
  };
}

function createPlayer(id, x, z, yaw) {
  return {
    id,
    position: { x, y: 0.55, z },
    velocity: { x: 0, y: 0, z: 0 },
    yaw,
    boost: 100,
    jumps: 2,
    grounded: true,
    radius: 1.2,
    jumpWasDown: false,
    airTime: 0,
    flipTimer: 0,
    flipDuration: 0,
    flipPitch: 0,
    flipRoll: 0,
    steerAmount: 0,
    boosting: false,
    input: { ...input },
  };
}

function createPowerup(type, x, z) {
  return {
    type,
    position: { x, y: 0.55, z },
    active: true,
    respawn: 0,
  };
}

function updateSimulation(state, dt) {
  PLAYER_IDS.forEach((id) => updatePlayer(state.players[id], dt));
  resolvePlayerBall(state.players.host, state.ball, 1.08);
  resolvePlayerBall(state.players.guest, state.ball, 1.08);
  resolvePlayerBump(state.players.host, state.players.guest);
  updateBall(state.ball, dt);
  updatePowerups(state, dt);
  checkGoals(state);
}

function updateGuestPreview(state, dt) {
  updatePlayer(state.players.guest, dt);
}

function updateAttractMode(state, dt) {
  state.players.host.input = {
    throttle: true,
    brake: false,
    left: Math.sin(performance.now() * 0.001) > 0.5,
    right: Math.sin(performance.now() * 0.001) < -0.5,
    jump: false,
    boost: false,
  };
  updatePlayer(state.players.host, dt);
}

function updatePlayer(player, dt) {
  const controls = player.input || input;
  const forward = { x: Math.sin(player.yaw), z: Math.cos(player.yaw) };
  const right = { x: Math.cos(player.yaw), z: -Math.sin(player.yaw) };
  const speed = Math.hypot(player.velocity.x, player.velocity.z);
  const steerPower = THREE.MathUtils.clamp(speed / 14, 0.52, 1.18);
  const steer = (controls.left ? 1 : 0) - (controls.right ? 1 : 0);
  const jumpPressed = controls.jump && !player.jumpWasDown;

  player.yaw += steer * steerPower * 4.15 * dt;
  player.steerAmount = steer;

  const throttle = (controls.throttle ? 1 : 0) - (controls.brake ? 0.72 : 0);
  const boostActive = controls.boost && player.boost > 0 && controls.throttle;
  const accel = boostActive ? 52 : 31;
  player.velocity.x += forward.x * throttle * accel * dt;
  player.velocity.z += forward.z * throttle * accel * dt;
  player.boosting = boostActive;

  if (boostActive) {
    player.boost = Math.max(0, player.boost - 46 * dt);
  } else {
    player.boost = Math.min(100, player.boost + 8 * dt);
  }

  if (jumpPressed && player.grounded && player.jumps > 0) {
    player.velocity.y = 10.4;
    player.grounded = false;
    player.jumps -= 1;
    player.airTime = 0;
  } else if (jumpPressed && !player.grounded && player.jumps > 0 && player.airTime < 0.95) {
    triggerAirFlip(player, controls, forward, right);
  }

  player.airTime = player.grounded ? 0 : player.airTime + dt;
  player.flipTimer = Math.max(0, player.flipTimer - dt);
  player.velocity.y -= 25 * dt;
  player.position.x += player.velocity.x * dt;
  player.position.y += player.velocity.y * dt;
  player.position.z += player.velocity.z * dt;

  const groundY = 0.55;
  if (player.position.y <= groundY) {
    player.position.y = groundY;
    player.velocity.y = Math.max(0, player.velocity.y);
    player.grounded = true;
    player.jumps = 2;
    player.airTime = 0;
    player.flipTimer = 0;
  }

  const drag = player.grounded ? 0.985 : 0.997;
  player.velocity.x *= drag;
  player.velocity.z *= drag;

  const maxSpeed = boostActive ? 43 : 31;
  clampHorizontalSpeed(player.velocity, maxSpeed);
  clampToField(player.position, player.velocity, player.radius);
  player.jumpWasDown = controls.jump;
}

function triggerAirFlip(player, controls, forward, right) {
  const forwardInput = (controls.throttle ? 1 : 0) - (controls.brake ? 1 : 0);
  const sideInput = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
  const hasDirection = Math.abs(forwardInput) + Math.abs(sideInput) > 0;
  const flipForward = hasDirection ? forwardInput : 1;
  const flipSide = hasDirection ? sideInput : 0;
  const impulseScale = hasDirection ? 15.5 : 11.5;

  player.velocity.x += (forward.x * flipForward + right.x * flipSide) * impulseScale;
  player.velocity.z += (forward.z * flipForward + right.z * flipSide) * impulseScale;
  player.velocity.y = Math.max(player.velocity.y, 6.8);
  player.jumps -= 1;
  player.flipDuration = 0.46;
  player.flipTimer = player.flipDuration;
  player.flipPitch = flipForward || 0;
  player.flipRoll = flipSide || 0;
}

function updateBall(ball, dt) {
  ball.velocity.y -= 19 * dt;
  ball.position.x += ball.velocity.x * dt;
  ball.position.y += ball.velocity.y * dt;
  ball.position.z += ball.velocity.z * dt;

  if (ball.position.y < ball.radius) {
    ball.position.y = ball.radius;
    ball.velocity.y = Math.abs(ball.velocity.y) * 0.58;
    ball.velocity.x *= 0.992;
    ball.velocity.z *= 0.992;
  }

  const sideLimit = FIELD.width / 2 - ball.radius;
  if (Math.abs(ball.position.x) > sideLimit) {
    ball.position.x = Math.sign(ball.position.x) * sideLimit;
    ball.velocity.x *= -0.82;
  }

  const backLimit = FIELD.depth / 2 - ball.radius;
  if (Math.abs(ball.position.z) > backLimit && Math.abs(ball.position.x) > FIELD.goalWidth / 2) {
    ball.position.z = Math.sign(ball.position.z) * backLimit;
    ball.velocity.z *= -0.82;
  }

  clampHorizontalSpeed(ball.velocity, 42);
}

function resolvePlayerBall(player, ball, force) {
  const dx = ball.position.x - player.position.x;
  const dz = ball.position.z - player.position.z;
  const minDistance = player.radius + ball.radius;
  const distance = Math.hypot(dx, dz);

  if (distance <= 0 || distance > minDistance) return;

  const nx = dx / distance;
  const nz = dz / distance;
  const overlap = minDistance - distance;
  ball.position.x += nx * overlap;
  ball.position.z += nz * overlap;

  const playerSpeed = Math.hypot(player.velocity.x, player.velocity.z);
  ball.velocity.x += nx * (10.5 + playerSpeed * 0.62) * force + player.velocity.x * 0.42;
  ball.velocity.z += nz * (10.5 + playerSpeed * 0.62) * force + player.velocity.z * 0.42;
  ball.velocity.y = Math.max(ball.velocity.y, Math.abs(player.velocity.y) * 0.2 + 2.2);
}

function resolvePlayerBump(a, b) {
  const dx = b.position.x - a.position.x;
  const dz = b.position.z - a.position.z;
  const minDistance = a.radius + b.radius;
  const distance = Math.hypot(dx, dz);

  if (distance <= 0 || distance > minDistance) return;

  const nx = dx / distance;
  const nz = dz / distance;
  const push = (minDistance - distance) * 0.5;
  a.position.x -= nx * push;
  a.position.z -= nz * push;
  b.position.x += nx * push;
  b.position.z += nz * push;

  const ax = a.velocity.x;
  const az = a.velocity.z;
  a.velocity.x = b.velocity.x * 0.45 - nx * 3;
  a.velocity.z = b.velocity.z * 0.45 - nz * 3;
  b.velocity.x = ax * 0.45 + nx * 3;
  b.velocity.z = az * 0.45 + nz * 3;
}

function updatePowerups(state, dt) {
  state.powerups.forEach((powerup) => {
    if (!powerup.active) {
      powerup.respawn -= dt;
      if (powerup.respawn <= 0) powerup.active = true;
      return;
    }

    PLAYER_IDS.forEach((id) => {
      const player = state.players[id];
      const distance = Math.hypot(
        player.position.x - powerup.position.x,
        player.position.z - powerup.position.z,
      );

      if (distance > 2.15) return;

      if (powerup.type === "boost") {
        player.boost = 100;
      } else if (powerup.type === "jump") {
        player.jumps = 2;
      } else if (powerup.type === "pulse") {
        resolvePlayerBall(player, state.ball, 2.2);
      }

      powerup.active = false;
      powerup.respawn = 9;
    });
  });
}

function checkGoals(state) {
  const ball = state.ball;
  const scoredInGoal = Math.abs(ball.position.z) > FIELD.depth / 2 + FIELD.goalDepth - ball.radius;
  const insideMouth = Math.abs(ball.position.x) < FIELD.goalWidth / 2;

  if (!scoredInGoal || !insideMouth || performance.now() < resetMessageTime) return;

  const scorer = ball.position.z < 0 ? "host" : "guest";
  state.score[scorer] += 1;
  resetKickoff(state);
  resetMessageTime = performance.now() + 1200;
  setStatus(`${scorer === "host" ? "Blue" : "Orange"} scored!`);
}

function resetKickoff(state) {
  state.players.host.position = { x: 0, y: 0.55, z: 25 };
  state.players.guest.position = { x: 0, y: 0.55, z: -25 };
  state.players.host.velocity = { x: 0, y: 0, z: 0 };
  state.players.guest.velocity = { x: 0, y: 0, z: 0 };
  state.players.host.yaw = Math.PI;
  state.players.guest.yaw = 0;
  state.players.host.jumps = 2;
  state.players.guest.jumps = 2;
  state.players.host.jumpWasDown = false;
  state.players.guest.jumpWasDown = false;
  state.players.host.flipTimer = 0;
  state.players.guest.flipTimer = 0;
  state.ball.position = { x: 0, y: 1.15, z: 0 };
  state.ball.velocity = { x: (Math.random() - 0.5) * 4, y: 0, z: (Math.random() - 0.5) * 4 };
}

function clampHorizontalSpeed(velocity, maxSpeed) {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed <= maxSpeed) return;
  const scale = maxSpeed / speed;
  velocity.x *= scale;
  velocity.z *= scale;
}

function clampToField(position, velocity, radius) {
  const xLimit = FIELD.width / 2 - radius;
  const zLimit = FIELD.depth / 2 - radius;

  if (Math.abs(position.x) > xLimit) {
    position.x = Math.sign(position.x) * xLimit;
    velocity.x *= -0.28;
  }

  if (Math.abs(position.z) > zLimit) {
    position.z = Math.sign(position.z) * zLimit;
    velocity.z *= -0.28;
  }
}

function createWorld() {
  const group = new THREE.Group();
  scene.add(group);

  const hemi = new THREE.HemisphereLight(0xbeeaff, 0x102030, 1.4);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 2.9);
  sun.position.set(-24, 42, 28);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -62;
  sun.shadow.camera.right = 62;
  sun.shadow.camera.top = 62;
  sun.shadow.camera.bottom = -62;
  scene.add(sun);

  const field = new THREE.Mesh(
    new THREE.BoxGeometry(FIELD.width, 0.25, FIELD.depth),
    new THREE.MeshStandardMaterial({ color: COLORS.grass, roughness: 0.86 }),
  );
  field.receiveShadow = true;
  field.position.y = -0.13;
  group.add(field);

  addTurfStripes(group);
  addLines(group);
  const goalNets = addWalls(group);
  addStadiumDetails(group);

  const hostCar = createCar(COLORS.host);
  const guestCar = createCar(COLORS.guest);
  const ball = createBall();
  group.add(hostCar, guestCar, ball);

  const powerups = gameState.powerups.map((powerup) => {
    const mesh = createPowerupMesh(powerup.type);
    group.add(mesh);
    return mesh;
  });
  const trails = createTrailMeshes(group);

  return {
    group,
    players: { host: hostCar, guest: guestCar },
    ball,
    powerups,
    goalNets,
    trails,
  };
}

function createTrailMeshes(group) {
  const dirtMaterial = new THREE.MeshBasicMaterial({
    color: 0x6a4a2b,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const boostMaterial = new THREE.MeshBasicMaterial({
    color: 0xffb13b,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const trails = {
    dirt: createTrailPool(group, 72, new THREE.BoxGeometry(0.34, 0.035, 0.78), dirtMaterial),
    boost: createTrailPool(group, 56, new THREE.ConeGeometry(0.22, 1.25, 6), boostMaterial),
  };
  return trails;
}

function createTrailPool(group, count, geometry, material) {
  const pool = [];
  for (let i = 0; i < count; i += 1) {
    const mesh = new THREE.Mesh(geometry, material.clone());
    mesh.visible = false;
    group.add(mesh);
    pool.push({ mesh, life: 0, maxLife: 1 });
  }
  return pool;
}

function addTurfStripes(group) {
  const stripeCount = 10;
  const stripeDepth = FIELD.depth / stripeCount;
  for (let i = 0; i < stripeCount; i += 1) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(FIELD.width - 0.7, 0.018, stripeDepth - 0.28),
      new THREE.MeshStandardMaterial({
        color: i % 2 === 0 ? COLORS.grassAlt : COLORS.grass,
        roughness: 0.9,
      }),
    );
    stripe.position.set(0, 0.005, -FIELD.depth / 2 + stripeDepth * (i + 0.5));
    stripe.receiveShadow = true;
    group.add(stripe);
  }
}

function addLines(group) {
  const lineMaterial = new THREE.MeshBasicMaterial({ color: COLORS.line, transparent: true, opacity: 0.45 });
  const centerLine = new THREE.Mesh(new THREE.BoxGeometry(FIELD.width, 0.035, 0.16), lineMaterial);
  centerLine.position.y = 0.03;
  group.add(centerLine);

  const sideLineMaterial = new THREE.MeshBasicMaterial({ color: 0x79f4ff, transparent: true, opacity: 0.28 });
  [-1, 1].forEach((xSide) => {
    const sideHash = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.035, FIELD.depth - 7), sideLineMaterial);
    sideHash.position.set(xSide * (FIELD.width / 2 - 4), 0.045, 0);
    group.add(sideHash);
  });

  const circle = new THREE.Mesh(
    new THREE.TorusGeometry(7.25, 0.07, 6, 76),
    lineMaterial,
  );
  circle.rotation.x = Math.PI / 2;
  circle.position.y = 0.06;
  group.add(circle);

  [-1, 1].forEach((side) => {
    const goalLine = new THREE.Mesh(new THREE.BoxGeometry(FIELD.goalWidth, 0.04, 0.18), lineMaterial);
    goalLine.position.set(0, 0.06, side * FIELD.depth / 2);
    group.add(goalLine);

    const boxTop = new THREE.Mesh(new THREE.BoxGeometry(FIELD.goalWidth, 0.045, 0.14), sideLineMaterial);
    boxTop.position.set(0, 0.06, side * (FIELD.depth / 2 - 9));
    group.add(boxTop);

    [-1, 1].forEach((xSide) => {
      const boxSide = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.045, 9), sideLineMaterial);
      boxSide.position.set(xSide * FIELD.goalWidth / 2, 0.06, side * (FIELD.depth / 2 - 4.5));
      group.add(boxSide);
    });
  });
}

function addWalls(group) {
  const material = new THREE.MeshStandardMaterial({
    color: 0x112c4c,
    roughness: 0.58,
    metalness: 0.12,
  });
  const railMaterial = new THREE.MeshStandardMaterial({ color: 0x6be8ff, emissive: 0x154c64, emissiveIntensity: 0.55 });
  const goalNets = [];

  const left = new THREE.Mesh(new THREE.BoxGeometry(0.45, FIELD.wall, FIELD.depth), material);
  const right = left.clone();
  left.position.set(-FIELD.width / 2 - 0.2, FIELD.wall / 2, 0);
  right.position.set(FIELD.width / 2 + 0.2, FIELD.wall / 2, 0);
  group.add(left, right);

  [-1, 1].forEach((xSide) => {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, FIELD.depth), railMaterial);
    rail.position.set(xSide * (FIELD.width / 2 + 0.06), FIELD.wall + 0.16, 0);
    group.add(rail);
  });

  [-1, 1].forEach((side) => {
    const wallWidth = (FIELD.width - FIELD.goalWidth) / 2;
    [-1, 1].forEach((xSide) => {
      const back = new THREE.Mesh(new THREE.BoxGeometry(wallWidth, FIELD.wall, 0.45), material);
      back.position.set(
        xSide * (FIELD.goalWidth / 2 + wallWidth / 2),
        FIELD.wall / 2,
        side * (FIELD.depth / 2 + 0.2),
      );
      group.add(back);
    });

    const frame = createGoalFrame(side);
    const net = createGoalNet(side);
    group.add(frame, net.mesh);
    goalNets.push(net);
  });

  return goalNets;
}

function createGoalFrame(side) {
  const frame = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: COLORS.blueGoal,
    emissive: COLORS.blueGoal,
    emissiveIntensity: 0.85,
    roughness: 0.22,
    metalness: 0.5,
  });
  const z = side * (FIELD.depth / 2 + FIELD.goalDepth);
  const postHeight = FIELD.wall * 1.38;
  const postGeo = new THREE.BoxGeometry(0.28, postHeight, 0.32);
  const crossGeo = new THREE.BoxGeometry(FIELD.goalWidth + 0.5, 0.26, 0.34);

  [-1, 1].forEach((xSide) => {
    const post = new THREE.Mesh(postGeo, material);
    post.position.set(xSide * FIELD.goalWidth / 2, postHeight / 2, z);
    post.castShadow = true;
    frame.add(post);
  });

  const crossbar = new THREE.Mesh(crossGeo, material);
  crossbar.position.set(0, postHeight, z);
  crossbar.castShadow = true;
  frame.add(crossbar);

  const base = new THREE.Mesh(new THREE.BoxGeometry(FIELD.goalWidth + 0.9, 0.18, 0.5), material);
  base.position.set(0, 0.18, z);
  frame.add(base);

  return frame;
}

function createGoalNet(side) {
  const net = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: COLORS.blueGoal,
    emissive: COLORS.blueGoal,
    emissiveIntensity: 0.42,
    roughness: 0.25,
    metalness: 0.25,
    transparent: true,
    opacity: 0.78,
  });
  const z = side * (FIELD.depth / 2 + FIELD.goalDepth + 0.18);
  const height = FIELD.wall * 1.28;
  const width = FIELD.goalWidth;
  const verticalGeo = new THREE.BoxGeometry(0.075, height, 0.075);
  const horizontalGeo = new THREE.BoxGeometry(width, 0.07, 0.075);

  for (let x = -width / 2; x <= width / 2 + 0.01; x += 1.7) {
    const bar = new THREE.Mesh(verticalGeo, material);
    bar.position.set(x, height / 2, z);
    net.add(bar);
  }

  for (let y = 0.55; y <= height + 0.01; y += 0.72) {
    const bar = new THREE.Mesh(horizontalGeo, material);
    bar.position.set(0, y, z);
    net.add(bar);
  }

  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, 0.05),
    new THREE.MeshBasicMaterial({ color: COLORS.blueGoal, transparent: true, opacity: 0.08 }),
  );
  glow.position.set(0, height / 2, z + side * 0.05);
  net.add(glow);

  return { mesh: net, material, glow };
}

function addStadiumDetails(group) {
  const standMaterial = new THREE.MeshStandardMaterial({ color: 0x0c1c32, roughness: 0.74, metalness: 0.08 });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: 0x265c89, emissive: 0x071f35, emissiveIntensity: 0.25 });

  [-1, 1].forEach((xSide) => {
    for (let i = 0; i < 3; i += 1) {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.2 + i * 0.55, FIELD.depth + 10), i % 2 ? accentMaterial : standMaterial);
      stand.position.set(xSide * (FIELD.width / 2 + 4.3 + i * 2.2), 0.55 + i * 0.55, 0);
      stand.receiveShadow = true;
      group.add(stand);
    }
  });

  [-1, 1].forEach((xSide) => {
    [-1, 1].forEach((zSide) => {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.18, 8, 8), accentMaterial);
      mast.position.set(xSide * (FIELD.width / 2 + 3.4), 4, zSide * (FIELD.depth / 2 - 7));
      group.add(mast);

      const lamp = new THREE.PointLight(0x9beeff, 1.15, 36, 2);
      lamp.position.set(xSide * (FIELD.width / 2 + 3.4), 8, zSide * (FIELD.depth / 2 - 7));
      group.add(lamp);

      const lampMesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.48, 0),
        new THREE.MeshBasicMaterial({ color: 0x9beeff }),
      );
      lampMesh.position.copy(lamp.position);
      group.add(lampMesh);
    });
  });
}

function createCar(color) {
  const car = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.18 });
  const trimMaterial = new THREE.MeshStandardMaterial({ color: 0xf3fbff, roughness: 0.3, metalness: 0.2 });
  const glassMaterial = new THREE.MeshStandardMaterial({ color: 0x081929, roughness: 0.2, metalness: 0.42 });

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.55, 0.58, 3.65),
    bodyMaterial,
  );
  body.castShadow = true;
  body.position.y = 0.28;
  car.add(body);

  const lower = new THREE.Mesh(new THREE.BoxGeometry(1.88, 0.24, 3.95), bodyMaterial);
  lower.castShadow = true;
  lower.position.y = 0.02;
  car.add(lower);

  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 0.58, 1.3),
    glassMaterial,
  );
  cabin.castShadow = true;
  cabin.position.set(0, 0.86, -0.28);
  car.add(cabin);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.35, 4),
    trimMaterial,
  );
  nose.castShadow = true;
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.38, 2.18);
  car.add(nose);

  const rearWing = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.16, 0.34), trimMaterial);
  rearWing.castShadow = true;
  rearWing.position.set(0, 1.04, -2.02);
  car.add(rearWing);

  [-1, 1].forEach((xSide) => {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.72, 0.12), trimMaterial);
    strut.castShadow = true;
    strut.position.set(xSide * 0.82, 0.68, -1.86);
    car.add(strut);

    const sideSkirt = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 3.35), trimMaterial);
    sideSkirt.castShadow = true;
    sideSkirt.position.set(xSide * 1.0, 0.24, 0);
    car.add(sideSkirt);
  });

  const headlights = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 0.12, 0.08),
    new THREE.MeshBasicMaterial({ color: 0xbff7ff }),
  );
  headlights.position.set(0, 0.48, 2.06);
  car.add(headlights);

  const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x07111f, roughness: 0.7 });
  [-1, 1].forEach((x) => {
    [-1, 1].forEach((z) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.3, 10), wheelMaterial);
      wheel.castShadow = true;
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x * 1.02, 0.08, z * 1.28);
      car.add(wheel);

      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.32, 8), trimMaterial);
      hub.rotation.z = Math.PI / 2;
      hub.position.copy(wheel.position);
      car.add(hub);
    });
  });

  return car;
}

function createBall() {
  const ball = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.04, 2),
    new THREE.MeshStandardMaterial({
      color: 0xe8f7ff,
      roughness: 0.26,
      metalness: 0.2,
      flatShading: true,
    }),
  );
  core.castShadow = true;
  ball.add(core);

  const hexMaterial = new THREE.MeshStandardMaterial({
    color: 0xf8fdff,
    roughness: 0.18,
    metalness: 0.18,
    flatShading: true,
  });
  const triangleMaterial = new THREE.MeshStandardMaterial({
    color: 0x60dcff,
    emissive: 0x0b8ab8,
    emissiveIntensity: 0.32,
    roughness: 0.15,
    metalness: 0.78,
    flatShading: true,
  });
  const seamMaterial = new THREE.MeshStandardMaterial({
    color: 0x12314a,
    roughness: 0.5,
    metalness: 0.2,
    flatShading: true,
  });

  createSpherePanels(34).forEach((normal, index) => {
    const panel = new THREE.Mesh(new THREE.CircleGeometry(index % 5 === 0 ? 0.34 : 0.3, 6), hexMaterial);
    orientPanelOnBall(panel, normal, 1.115, index * 0.37);
    ball.add(panel);
  });

  createSpherePanels(18, 0.55).forEach((normal, index) => {
    const triangle = new THREE.Mesh(new THREE.CircleGeometry(0.24, 3), triangleMaterial);
    orientPanelOnBall(triangle, normal, 1.135, index * 0.71);
    ball.add(triangle);
  });

  createSpherePanels(24, 0.22).forEach((normal, index) => {
    const rivet = new THREE.Mesh(new THREE.CircleGeometry(0.075, 6), seamMaterial);
    orientPanelOnBall(rivet, normal, 1.145, index * 0.21);
    ball.add(rivet);
  });

  return ball;
}

function createSpherePanels(count, offset = 0) {
  const points = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = i * goldenAngle + offset;
    points.push(new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius).normalize());
  }
  return points;
}

function orientPanelOnBall(mesh, normal, radius, spin) {
  mesh.position.copy(normal).multiplyScalar(radius);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  mesh.rotateZ(spin);
}

function createPowerupMesh(type) {
  const color = type === "boost" ? 0xffb13b : type === "jump" ? 0x8dff9f : 0xbd78ff;
  const group = new THREE.Group();
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(1.18, 1.36, 0.13, 16),
    new THREE.MeshStandardMaterial({ color: 0x112844, roughness: 0.35, metalness: 0.45 }),
  );
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(1.25, 0.08, 8, 36),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72 }),
  );
  const icon = new THREE.Mesh(
    type === "boost" ? new THREE.ConeGeometry(0.42, 0.95, 5) : new THREE.OctahedronGeometry(0.64, 0),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, roughness: 0.25 }),
  );

  pad.receiveShadow = true;
  halo.rotation.x = Math.PI / 2;
  icon.position.y = 0.64;
  if (type === "boost") icon.rotation.x = -Math.PI / 2;
  group.add(pad, halo, icon);
  return group;
}

function updateMeshes(state) {
  PLAYER_IDS.forEach((id) => {
    const player = state.players[id];
    const mesh = objects.players[id];
    mesh.position.set(player.position.x, player.position.y, player.position.z);
    const flipProgress =
      player.flipDuration > 0 ? 1 - THREE.MathUtils.clamp(player.flipTimer / player.flipDuration, 0, 1) : 1;
    const flipSpin = player.flipTimer > 0 ? flipProgress * Math.PI * 2 : 0;
    const pitch = player.flipPitch * flipSpin;
    const roll = player.flipRoll * flipSpin + player.velocity.y * -0.015;
    mesh.rotation.set(pitch, player.yaw, roll);
    spawnCarTrails(player, id);
  });

  objects.ball.position.set(state.ball.position.x, state.ball.position.y, state.ball.position.z);
  objects.ball.rotation.x += state.ball.velocity.z * 0.012;
  objects.ball.rotation.z -= state.ball.velocity.x * 0.012;

  state.powerups.forEach((powerup, index) => {
    const mesh = objects.powerups[index];
    mesh.visible = powerup.active;
    mesh.position.set(powerup.position.x, powerup.position.y + Math.sin(performance.now() * 0.004 + index) * 0.12, powerup.position.z);
    mesh.rotation.y += 0.035;
  });

  objects.goalNets.forEach((net, index) => {
    const pulse = 0.42 + Math.sin(performance.now() * 0.0024 + index) * 0.18;
    net.material.emissiveIntensity = pulse;
    net.material.opacity = 0.62 + pulse * 0.24;
    net.glow.material.opacity = 0.06 + pulse * 0.08;
  });

  updateTrailPool(objects.trails.dirt, 0.024, 1.012);
  updateTrailPool(objects.trails.boost, 0.034, 1.018);
}

function spawnCarTrails(player, id) {
  const speed = Math.hypot(player.velocity.x, player.velocity.z);
  const carBack = new THREE.Vector3(-Math.sin(player.yaw) * 1.65, 0, -Math.cos(player.yaw) * 1.65);
  const carRight = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  const base = new THREE.Vector3(player.position.x, 0.08, player.position.z).add(carBack);

  if (player.grounded && Math.abs(player.steerAmount) > 0.1 && speed > 7) {
    [-1, 1].forEach((side) => {
      const offset = carRight.clone().multiplyScalar(side * 0.78);
      spawnTrailParticle(
        objects.trails.dirt,
        trailState.dirtCursor,
        base.clone().add(offset),
        player.yaw + (Math.random() - 0.5) * 0.45,
        0.62,
        0.55 + Math.random() * 0.2,
      );
      trailState.dirtCursor = (trailState.dirtCursor + 1) % objects.trails.dirt.length;
    });
  }

  if (player.boosting) {
    const boostColor = id === "host" ? 0x59d8ff : 0xffa04b;
    [-0.32, 0.32].forEach((side) => {
      const offset = carRight.clone().multiplyScalar(side);
      const point = base.clone().add(offset);
      spawnTrailParticle(
        objects.trails.boost,
        trailState.boostCursor,
        point,
        player.yaw + Math.PI,
        0.38,
        0.62 + Math.random() * 0.18,
        boostColor,
      );
      trailState.boostCursor = (trailState.boostCursor + 1) % objects.trails.boost.length;
    });
  }
}

function spawnTrailParticle(pool, index, position, yaw, maxLife, scale, color) {
  const particle = pool[index];
  particle.life = maxLife;
  particle.maxLife = maxLife;
  particle.mesh.visible = true;
  particle.mesh.position.copy(position);
  particle.mesh.rotation.set(Math.PI / 2, 0, -yaw);
  particle.mesh.scale.setScalar(scale);
  particle.mesh.material.opacity = 0.68;
  if (color) particle.mesh.material.color.setHex(color);
}

function updateTrailPool(pool, fadeSpeed, growSpeed) {
  pool.forEach((particle) => {
    if (particle.life <= 0) return;

    particle.life -= fadeSpeed;
    const alpha = Math.max(0, particle.life / particle.maxLife);
    particle.mesh.material.opacity = alpha * 0.58;
    particle.mesh.scale.multiplyScalar(growSpeed);
    if (particle.life <= 0) particle.mesh.visible = false;
  });
}

function updateCamera(localId, dt) {
  const player = gameState.players[localId] || gameState.players.host;
  const back = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const target = new THREE.Vector3(player.position.x, player.position.y + 1.4, player.position.z);
  const desired = target.clone().add(back.multiplyScalar(14.5)).add(new THREE.Vector3(0, 9.2, 0));

  camera.position.lerp(desired, 1 - Math.pow(0.001, dt));
  camera.lookAt(target.lerp(new THREE.Vector3(gameState.ball.position.x, gameState.ball.position.y, gameState.ball.position.z), 0.18));
}

function updateHud(localId) {
  scoreEl.textContent = `${gameState.score.host} - ${gameState.score.guest}`;
  const player = gameState.players[localId] || gameState.players.host;
  boostBar.style.width = `${Math.round(player.boost)}%`;

  if (role === "host" && !connected && roomIdEl.textContent !== "...") {
    setStatus(`Waiting for guest. Share lobby code ${roomIdEl.textContent}.`);
  }
}

function serializeState(state) {
  return JSON.parse(JSON.stringify(state));
}

function copyNetworkState(target, source) {
  PLAYER_IDS.forEach((id) => {
    Object.assign(target.players[id].position, source.players[id].position);
    Object.assign(target.players[id].velocity, source.players[id].velocity);
    target.players[id].yaw = source.players[id].yaw;
    target.players[id].boost = source.players[id].boost;
    target.players[id].jumps = source.players[id].jumps;
    target.players[id].grounded = source.players[id].grounded;
    target.players[id].jumpWasDown = source.players[id].jumpWasDown;
    target.players[id].airTime = source.players[id].airTime;
    target.players[id].flipTimer = source.players[id].flipTimer;
    target.players[id].flipDuration = source.players[id].flipDuration;
    target.players[id].flipPitch = source.players[id].flipPitch;
    target.players[id].flipRoll = source.players[id].flipRoll;
    target.players[id].steerAmount = source.players[id].steerAmount;
    target.players[id].boosting = source.players[id].boosting;
  });

  Object.assign(target.ball.position, source.ball.position);
  Object.assign(target.ball.velocity, source.ball.velocity);
  target.score.host = source.score.host;
  target.score.guest = source.score.guest;

  source.powerups.forEach((powerup, index) => {
    target.powerups[index].active = powerup.active;
    target.powerups[index].respawn = powerup.respawn;
  });
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
