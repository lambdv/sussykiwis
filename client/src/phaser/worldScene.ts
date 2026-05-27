import Phaser from "phaser";
import { PlayerInputController } from "../core/inputController";

let lastSnapshotRxTime = 0;
import {
  canLocallyMove,
  getFacingFromMovement,
  getMapHalfExtents,
  predictLocalPlayer,
  pruneProcessedInputs,
  updateRenderTime,
  type PendingInput,
  type RemoteSnapshot,
} from "../core/movement";
import { ClientSession, type ClientSessionState } from "../core/session";
import type { PuzzleKind, SnapshotDeadBody, SnapshotPlayer, WorldSnapshot } from "../networking/message";
import { parseAuthoredMap, parseLobbyLayout, resolveAuthoredPosition, resolveLobbyPosition, type AuthoredMapLayout, type LobbyLayout } from "./lobbyLdtk";
type PlayerVisual = {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  snapshots: RemoteSnapshot[];
  facingLeft: boolean;
  lastInputFacingLeft: boolean | null;
  movePhase: number;
  isMoving: boolean;
  lastRenderX: number;
  lastRenderY: number;
};

type BodyVisual = {
  body: Phaser.GameObjects.Rectangle | Phaser.GameObjects.Sprite;
};

type PuzzleVisual = {
  container: Phaser.GameObjects.Container;
  ring: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  icon: Phaser.GameObjects.Image;
  miniPuzzle: Phaser.GameObjects.Graphics;
};

type BorrowVisual = {
  container: Phaser.GameObjects.Container;
  ring: Phaser.GameObjects.Arc;
  icon: Phaser.GameObjects.Image;
};

export class WorldScene extends Phaser.Scene {
  // Keep the kiwi sprite compact so it reads as a character, not the whole tile.
  private static readonly PLAYER_BASE_SCALE = 0.05;
  private static readonly LOBBY_CAMERA_ZOOM = 4.5;
  private static readonly IN_GAME_CAMERA_ZOOM = 2.4;
  private session: ClientSession;
  private unsubscribe: (() => void) | null = null;
  private inputController: PlayerInputController | null = null;
  private state: ClientSessionState;
  private latestServerTime = 0;
  private renderTime = 0;
  private pendingInputs: PendingInput[] = [];
  private lastBorrowDirection: "up" | "down" | "left" | "right" | null = null;
  private playerTextureCache = new Map<string, string>();
  private players = new Map<string, PlayerVisual>();
  private bodies = new Map<string, BodyVisual>();
  private puzzles = new Map<string, PuzzleVisual>();
  private borrows = new Map<string, BorrowVisual>();
  private arena!: Phaser.GameObjects.Graphics;
  private lobbyMap: Phaser.GameObjects.Container | null = null;
  private lobbyLayout: LobbyLayout | null = null;
  private matchLayout: AuthoredMapLayout | null = null;
  private matchMapParts: Array<Phaser.GameObjects.Container | Phaser.GameObjects.Rectangle> = [];
  private matchLayers = new Map<string, Phaser.GameObjects.Container>();

  constructor(session: ClientSession) {
    super("world");
    this.session = session;
    this.state = session.getState();
  }

  create() {
    // Keep a single top-down scene alive while overlays swap around it.
    this.cameras.main.setBackgroundColor("#bfe7ff");
    this.arena = this.add.graphics();
    this.initializeLobbyMap();
    this.initializeMatchMap();
    this.inputController = new PlayerInputController();
    this.unsubscribe = this.session.subscribe((state) => {
      this.state = state;
      this.syncSnapshot(state.snapshot);
      const showJoystick = state.viewMode === "player" && state.route === "world";
      this.inputController?.setVisible(showJoystick);
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.inputController?.dispose();
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.lobbyMap?.destroy(true);
      this.lobbyMap = null;
      this.matchLayout = null;
      for (const part of this.matchMapParts) {
        part.destroy(true);
      }
      this.matchMapParts = [];
      this.matchLayers.clear();
      this.players.clear();
      this.bodies.clear();
      this.puzzles.clear();
      this.borrows.clear();
    });
  }

  preload() {
    // Load the shared kiwi source sprite once, then recolor it per player in memory.
    this.load.image("kiwi-source", "/assets/2d/kwi.png");
    this.load.image("kiwi-fruit", "/assets/kiwis/kiwi_fruit.png");
    this.load.image("spinner", "/assets/2d/spinner.png");
    this.load.image("breadboard", "/assets/2d/breadboard.png");
    this.load.image("borrow", "/assets/2d/borrow.png");
    this.load.json("lobby-ldtk", "/assets/game.ldtk");
    this.load.json("match-ldtk", "/assets/amongus.ldtk");
  }

  update(_time: number, delta: number) {
    const snapshot = this.state.snapshot;
    const inputController = this.inputController;
    if (!snapshot || !inputController) {
      return;
    }

    this.latestServerTime = Math.max(this.latestServerTime, snapshot.serverTime);
    this.renderTime = updateRenderTime(this.renderTime, this.latestServerTime, delta);
    this.updateMovement(snapshot, delta / 1000);
    this.interpolateRemotePlayers();
    this.updatePlayerMotion(delta / 1000);
    this.updateCamera(snapshot);
  }

  private syncSnapshot(snapshot: WorldSnapshot | null) {
    if (!snapshot) {
      this.arena.clear();
      this.lobbyMap?.setVisible(false);
      this.setMatchMapVisible(false);
      return;
    }

    this.drawArena(snapshot);
    this.syncPlayers(snapshot);
    this.syncBodies(snapshot.deadBodies);
    this.syncPuzzles(snapshot);
    this.syncBorrows(snapshot);
  }

  private drawArena(snapshot: WorldSnapshot) {
    if (snapshot.phase === "lobby") {
      const lobbyMap = this.lobbyMap;
      if (!lobbyMap) {
        return;
      }

      // Keep the authored lobby visible during pre-match.
      this.arena.clear();
      lobbyMap.setVisible(true);
      this.setMatchMapVisible(false);
      const lightsOff = snapshot.activeSabotages.some((sabotage) => sabotage.kind === "lights_off");
      lobbyMap.setAlpha(lightsOff ? 0.35 : 1);
      this.cameras.main.setBackgroundColor(lightsOff ? "#05070b" : "#bfe7ff");
      return;
    }

    if (this.matchMapParts.length > 0) {
      // Swap the active round over to the dedicated amongus LDtk render.
      this.arena.clear();
      this.lobbyMap?.setVisible(false);
      this.setMatchMapVisible(true);
      this.setMatchMapAlpha(snapshot.activeSabotages.some((sabotage) => sabotage.kind === "lights_off") ? 0.35 : 0.82);
      this.updateMatchRoofVisibility();
      this.cameras.main.setBackgroundColor(snapshot.activeSabotages.some((sabotage) => sabotage.kind === "lights_off") ? "#05070b" : "#bfe7ff");
      return;
    }

    if (this.lobbyMap !== null) {
      this.lobbyMap.setVisible(false);
    }
    this.setMatchMapVisible(false);
    // Determine the map boundaries. We add a visual padding of 4 units (64 pixels)
    // so that when the player reaches the map's boundary, the rendered borders are
    // further away from their position, avoiding a cramped feeling at the edges.
    const visualPadding = 4;
    const drawHalfWidth = snapshot.mapHalfExtentX + visualPadding;
    const drawHalfHeight = snapshot.mapHalfExtentZ + visualPadding;
    
    // Choose floor/border colors depending on active sabotages and game phase.
    const lightsOff = snapshot.activeSabotages.some((sabotage) => sabotage.kind === "lights_off");
    const baseColor = lightsOff ? 0x05070b : 0x10263a;
    const borderColor = 0x7dd3fc;

    // Draw the arena background and outer border boundaries with the visual padding.
    this.arena.clear();
    this.arena.fillStyle(baseColor, 1);
    this.arena.fillRect(-drawHalfWidth * 16, -drawHalfHeight * 16, drawHalfWidth * 32, drawHalfHeight * 32);
    this.arena.lineStyle(6, borderColor, 1);
    this.arena.strokeRect(-drawHalfWidth * 16, -drawHalfHeight * 16, drawHalfWidth * 32, drawHalfHeight * 32);

    // We do NOT set the camera bounds here. This simplifies camera following and 
    // prevents the camera from getting stuck or colliding at the top-left boundary, 
    // which previously caused the player to become off-centered.
  }

  private syncPlayers(snapshot: WorldSnapshot) {
    const localPlayerId = this.state.localPlayerId;
    const liveIds = new Set<string>();
    const grayPlayers = snapshot.activeSabotages.some((sabotage) => sabotage.kind === "gray_players");

    for (const player of snapshot.players) {
      liveIds.add(player.id);
      const visual = this.upsertPlayer(player);
      visual.sprite.setTint(grayPlayers ? 0x8e909a : Phaser.Display.Color.HexStringToColor(player.color).color);
      visual.label.setColor(this.state.localRole === "imposter" && player.role === "imposter" ? "#ff5d73" : "#f8fafc");

      const isGhost = player.state === "ghost";
      const isVisible = this.state.viewMode === "spectator" || player.id === localPlayerId || !isGhost;
      visual.container.setVisible(isVisible);
      visual.container.setAlpha(player.state === "dead" ? 0.35 : isGhost ? 0.6 : 1);

      if (player.id === localPlayerId) {
        // Drop server-acked inputs, but keep rendering from local prediction while movement is allowed.
        pruneProcessedInputs(this.pendingInputs, player.lastProcessedSeq);
        if (!canLocallyMove(snapshot.phase, player.state) || player.currentBorrowId !== null) {
          visual.container.setPosition(player.x * 16, player.z * 16);
          visual.isMoving = false;
        }
        visual.facingLeft = this.pendingInputs.length > 0 && visual.lastInputFacingLeft !== null
          ? visual.lastInputFacingLeft
          : player.facingLeft;
      } else {
        visual.snapshots.push({
          time: snapshot.serverTime,
          x: player.x * 16,
          y: player.z * 16,
          facingLeft: player.facingLeft,
        });
        if (visual.snapshots.length > 10) {
          visual.snapshots.shift();
        }
      }
    }

    for (const [id, visual] of this.players) {
      if (liveIds.has(id)) continue;
      visual.container.destroy();
      this.players.delete(id);
    }
  }

  private syncBodies(bodies: SnapshotDeadBody[]) {
    const liveIds = new Set<string>();
    for (const body of bodies) {
      liveIds.add(body.id);
      const visual = this.bodies.get(body.id) ?? this.createBody(body.id);
      visual.body.setPosition(body.x * 16, body.z * 16);
      visual.body.setAlpha(body.reported ? 0.45 : 1);
    }

    for (const [id, visual] of this.bodies) {
      if (liveIds.has(id)) continue;
      visual.body.destroy();
      this.bodies.delete(id);
    }
  }

  private syncPuzzles(snapshot: WorldSnapshot) {
    lastSnapshotRxTime = Date.now();

    if (snapshot.phase === "lobby") {
      for (const [id, visual] of this.puzzles) {
        visual.container.destroy();
        this.puzzles.delete(id);
      }
      for (const [id, visual] of this.borrows) {
        visual.container.destroy();
        this.borrows.delete(id);
      }
      return;
    }

    const localPlayerId = this.state.localPlayerId;
    const liveIds = new Set<string>();
      for (const station of snapshot.puzzleStations) {
        liveIds.add(station.id);
        const visual = this.puzzles.get(station.id) ?? this.createPuzzle(station.id, station.kind);
        visual.container.setPosition(station.x * 16, station.z * 16);
        visual.ring.setStrokeStyle(4, station.kind === "timer" ? 0xc084fc : 0x38bdf8, 1);
        visual.ring.setFillStyle(
          localPlayerId && station.completedBy.includes(localPlayerId) ? 0x34d399 : 0x111827,
          station.occupiedBy ? 1 : 0.88,
        );
        visual.label.setText(station.kind === "timer" ? "T" : "W");

        // Spectator view for puzzles
        if (this.state.viewMode === "spectator" && station.occupiedBy && station.projection) {
          visual.miniPuzzle.setAlpha(1);
          visual.miniPuzzle.clear();
          visual.miniPuzzle.fillStyle(0x08111f, 0.9);
          visual.miniPuzzle.fillRect(-20, -20, 40, 40);
          
          if (station.projection.kind === "timer") {
            const serverElapsed = snapshot.serverTime - station.projection.startedAt;
            const angle = ((serverElapsed + (Date.now() - lastSnapshotRxTime)) * 0.28 * 20 / 1000) % (Math.PI * 2);
            visual.miniPuzzle.lineStyle(2, 0xf472b6);
            visual.miniPuzzle.beginPath();
            visual.miniPuzzle.moveTo(0, 0);
            visual.miniPuzzle.lineTo(15 * Math.cos(angle - Math.PI/2), 15 * Math.sin(angle - Math.PI/2));
            visual.miniPuzzle.strokePath();
          } else if (station.projection.kind === "wires") {
            const pairs = station.projection.connectedPairs;
            visual.miniPuzzle.lineStyle(2, 0x34d399);
            pairs.forEach(p => {
              visual.miniPuzzle.beginPath();
              visual.miniPuzzle.moveTo(-10, -10 + p.fromIndex * 6);
              visual.miniPuzzle.lineTo(10, -10 + p.toIndex * 6);
              visual.miniPuzzle.strokePath();
            });
          }
        } else {
          visual.miniPuzzle.setAlpha(0);
        }
      }

    for (const [id, visual] of this.puzzles) {
      if (liveIds.has(id)) continue;
      visual.container.destroy();
      this.puzzles.delete(id);
    }
  }

  private syncBorrows(snapshot: WorldSnapshot) {
    if (snapshot.phase === "lobby") {
      for (const [id, visual] of this.borrows) {
        visual.container.destroy();
        this.borrows.delete(id);
      }
      return;
    }

    const liveIds = new Set<string>();

    for (const borrow of snapshot.kiwiBorrows) {
      liveIds.add(borrow.id);
      const visual = this.borrows.get(borrow.id) ?? this.createBorrow(borrow.id);
      visual.container.setPosition(borrow.x * 16, borrow.z * 16);
    }

    for (const [id, visual] of this.borrows) {
      if (liveIds.has(id)) continue;
      visual.container.destroy();
      this.borrows.delete(id);
    }
  }

  private updateMovement(snapshot: WorldSnapshot, dt: number) {
    const localPlayerId = this.state.localPlayerId;
    if (!localPlayerId || this.state.viewMode === "spectator") {
      return;
    }

    const localPlayer = snapshot.players.find((player) => player.id === localPlayerId);
    const visual = this.players.get(localPlayerId);
    if (!localPlayer || !visual) {
      return;
    }

    if (localPlayer.currentBorrowId === null) {
      // Drop stale borrow predictions once the server says the player is back outside.
      this.lastBorrowDirection = null;
    }

    const input = this.inputController?.getInput() ?? { x: 0, y: 0 };
    const seq = this.session.nextInputSeq();
    const facing = getFacingFromMovement(input.x, input.y);
    const moving = input.x !== 0 || input.y !== 0;
    const activeBorrow = snapshot.kiwiBorrows.find((borrow) => borrow.id === localPlayer.currentBorrowId) ?? null;

    if (canLocallyMove(snapshot.phase, localPlayer.state)) {
      if (activeBorrow) {
        const borrowDirection = this.getBorrowDirection(input.x, input.y);
        if (borrowDirection && borrowDirection !== this.lastBorrowDirection) {
          this.lastBorrowDirection = borrowDirection;
          this.session.traverseBorrow(borrowDirection);
        } else if (!borrowDirection) {
          this.lastBorrowDirection = null;
        }

        visual.isMoving = false;
        this.pendingInputs.push({ seq, moveX: 0, moveY: 0, dt, facingLeft: facing });
        if (this.pendingInputs.length > 120) {
          this.pendingInputs.shift();
        }
        this.session.sendInput(seq, 0, 0);
        return;
      }

      const predicted = predictLocalPlayer(
        visual.container.x / 16,
        visual.container.y / 16,
        input.x,
        input.y,
        dt,
        this.session.getMoveSpeed(),
        getMapHalfExtents(snapshot),
        snapshot.phase,
      );

      const resolved = this.resolveLocalStep(visual.container.x / 16, visual.container.y / 16, predicted.x, predicted.y, snapshot.phase);
      visual.container.setPosition(resolved.x * 16, resolved.y * 16);
      if (facing !== null) {
        visual.facingLeft = facing;
        visual.lastInputFacingLeft = facing;
      }
      visual.isMoving = moving;
      this.pendingInputs.push({ seq, moveX: input.x, moveY: input.y, dt, facingLeft: facing });
      if (this.pendingInputs.length > 120) {
        this.pendingInputs.shift();
      }
      this.lastBorrowDirection = null;
    }

    this.session.sendInput(seq, input.x, input.y);
  }

  private interpolateRemotePlayers() {
    for (const [id, visual] of this.players) {
      if (id === this.state.localPlayerId) continue;
      if (visual.snapshots.length === 0) continue;
      const latest = visual.snapshots[visual.snapshots.length - 1];
      visual.container.setPosition(latest.x, latest.y);
      visual.facingLeft = latest.facingLeft;
      visual.isMoving = Math.abs(latest.x - visual.lastRenderX) + Math.abs(latest.y - visual.lastRenderY) > 0.1;
      visual.lastRenderX = latest.x;
      visual.lastRenderY = latest.y;
    }
  }

  private updatePlayerMotion(dt: number) {
    for (const visual of this.players.values()) {
      if (visual.isMoving) {
        visual.movePhase = (visual.movePhase + dt * 14) % (Math.PI * 2);
      }

      const hop = visual.isMoving ? Math.max(0, Math.sin(visual.movePhase)) : 0;
      visual.sprite.setFlipX(!visual.facingLeft);
      visual.sprite.setY(-hop * 6);
      visual.sprite.setScale(WorldScene.PLAYER_BASE_SCALE - hop * 0.03, WorldScene.PLAYER_BASE_SCALE + hop * 0.03);
    }
  }

  private updateCamera(snapshot: WorldSnapshot) {
    if (this.state.viewMode === "spectator" && snapshot.phase === "lobby" && this.lobbyLayout) {
      // Fit the authored lobby map instead of the old oversized placeholder arena.
      this.cameras.main.stopFollow();
      this.cameras.main.centerOn(0, 0);
      this.cameras.main.setZoom(Math.max(WorldScene.LOBBY_CAMERA_ZOOM, Math.min(4.4, Math.min(this.cameras.main.width / (this.lobbyLayout.width * 16), this.cameras.main.height / (this.lobbyLayout.height * 16)) * WorldScene.LOBBY_CAMERA_ZOOM)));
      return;
    }

    const visualPadding = 4;
    const drawHalfWidth = snapshot.mapHalfExtentX + visualPadding;
    const drawHalfHeight = snapshot.mapHalfExtentZ + visualPadding;

    if (this.state.viewMode === "spectator") {
      // Keep gameplay closer so the authored map no longer looks tiny in-match.
      this.cameras.main.stopFollow();
      this.cameras.main.centerOn(0, 0);
      this.cameras.main.setZoom(Math.max(WorldScene.IN_GAME_CAMERA_ZOOM, Math.min(3.2, Math.min(720 / (drawHalfWidth * 32), 720 / (drawHalfHeight * 32)))));
      return;
    }

    const localPlayer = this.state.localPlayerId ? this.players.get(this.state.localPlayerId) : null;
    if (localPlayer) {
      // Start following the local player container with a lerp value of 1 to keep
      // the camera always centered on the player position without lag or deadzone.
      this.cameras.main.startFollow(localPlayer.container, true, 1, 1);
      
      // Calculate normalized zoom based on reference screen proportions.
      // This guarantees that players with larger displays or zoomed-out browsers
      // see exactly the same amount of the game board as smaller screens, rather than
      // gaining an unfair advantage by rendering a wider perspective.
      const targetWidth = 711;
      const targetHeight = 400;
      const zoomX = this.cameras.main.width / targetWidth;
      const zoomY = this.cameras.main.height / targetHeight;
      const zoom = snapshot.phase === "lobby"
        ? Math.max(WorldScene.LOBBY_CAMERA_ZOOM, Math.max(zoomX, zoomY))
        : Math.max(WorldScene.IN_GAME_CAMERA_ZOOM, Math.max(zoomX, zoomY));

      this.cameras.main.setZoom(zoom);
    }
  }

  private upsertPlayer(player: SnapshotPlayer) {
    const existing = this.players.get(player.id);
    if (existing) {
      existing.sprite.setTexture(this.getPlayerTexture(player.color));
      return existing;
    }

    const sprite = this.add.sprite(0, 0, this.getPlayerTexture(player.color)).setScale(WorldScene.PLAYER_BASE_SCALE);
    const label = this.add.text(0, -28, "", {
      fontFamily: "Arial, sans-serif",
      fontSize: "14px",
      color: "#f8fafc",
      stroke: "#020617",
      strokeThickness: 4,
      align: "center",
    }).setOrigin(0.5).setVisible(false);
    const container = this.add.container(player.x * 16, player.z * 16, [sprite, label]);
    container.setDepth(10);

const visual = {
      container,
      sprite,
      label,
      snapshots: [],
      facingLeft: player.facingLeft,
      lastInputFacingLeft: null,
      movePhase: 0,
      isMoving: false,
      lastRenderX: player.x * 16,
      lastRenderY: player.z * 16,
    };
    this.players.set(player.id, visual);
    return visual;
  }

  private createBody(id: string) {
    // Reuse the fruit sprite so dead bodies read as a fallen kiwi instead of a placeholder shape.
    const body = this.add.sprite(0, 0, "kiwi-fruit").setScale(WorldScene.PLAYER_BASE_SCALE * 0.9).setRotation(Math.PI / 2).setDepth(4);
    const visual = { body };
    this.bodies.set(id, visual);
    return visual;
  }

  private createPuzzle(id: string, kind: PuzzleKind) {
    const ring = this.add.circle(0, 0, 16, 0x111827, 0.9).setStrokeStyle(4, kind === "timer" ? 0xc084fc : 0x38bdf8, 1);
    const icon = this.add.image(0, 0, kind === "timer" ? "spinner" : "breadboard").setDisplaySize(24, 24);
    const miniPuzzle = this.add.graphics({ x: 0, y: -30 }).setAlpha(0);
    const label = this.add.text(0, -20, "", { fontSize: "12px", color: "#ffffff" }).setOrigin(0.5);
    const container = this.add.container(0, 0, [ring, icon, miniPuzzle, label]).setDepth(6);
    const visual = { container, ring, icon, miniPuzzle, label };
    this.puzzles.set(id, visual);
    return visual;
  }

  private createBorrow(id: string) {
    const ring = this.add.circle(0, 0, 13, 0x7c3aed, 0.95).setStrokeStyle(4, 0xf5d0fe, 1);
    const icon = this.add.image(0, 0, "borrow").setDisplaySize(18, 18);
    const container = this.add.container(0, 0, [ring, icon]).setDepth(7);
    const visual = { container, ring, icon };
    this.borrows.set(id, visual);
    return visual;
  }

  private getBorrowDirection(x: number, y: number) {
    if (Math.abs(x) < 0.2 && Math.abs(y) < 0.2) {
      return null;
    }

    if (Math.abs(x) >= Math.abs(y)) {
      return x < 0 ? "left" : "right";
    }

    return y < 0 ? "up" : "down";
  }

  private initializeLobbyMap() {
    this.lobbyLayout = parseLobbyLayout(this.cache.json.get("lobby-ldtk"));
    if (!this.lobbyLayout) {
      return;
    }

    const textureKey = "lobby-tiles";
    if (this.textures.exists(textureKey)) {
      this.buildLobbyMap(textureKey);
      return;
    }

    this.load.image(textureKey, this.lobbyLayout.tilesetPath);
    this.load.once(Phaser.Loader.Events.COMPLETE, () => this.buildLobbyMap(textureKey));
    this.load.start();
  }

  private initializeMatchMap() {
    this.matchLayout = parseAuthoredMap(this.cache.json.get("match-ldtk"));
    if (!this.matchLayout) {
      return;
    }

    const textureKeys = new Map<string, string>();
    const missingTextures: Array<{ key: string; path: string }> = [];
    for (const layer of this.matchLayout.layers) {
      if (textureKeys.has(layer.tilesetPath)) {
        continue;
      }

      const key = `match-tiles-${textureKeys.size}`;
      textureKeys.set(layer.tilesetPath, key);
      if (!this.textures.exists(key)) {
        missingTextures.push({ key, path: layer.tilesetPath });
      }
    }

    if (missingTextures.length === 0) {
      this.buildMatchMap(textureKeys);
      return;
    }

    // Load every tileset once so the authored layer order can be reconstructed exactly.
    for (const texture of missingTextures) {
      this.load.image(texture.key, texture.path);
    }
    this.load.once(Phaser.Loader.Events.COMPLETE, () => this.buildMatchMap(textureKeys));
    this.load.start();
  }

  private buildLobbyMap(textureKey: string) {
    if (!this.lobbyLayout || this.lobbyMap) {
      return;
    }

    const lobbyMap = this.add.container(0, 0).setDepth(0).setVisible(false);
    const levelWidth = this.lobbyLayout.width * this.lobbyLayout.gridSize;
    const levelHeight = this.lobbyLayout.height * this.lobbyLayout.gridSize;
    lobbyMap.add(this.add.rectangle(0, 0, levelWidth, levelHeight, 0xbfe7ff).setOrigin(0.5));

    // Draw the LDtk-authored ground layer directly so the lobby visuals match the collision grid.
    for (const tile of this.lobbyLayout.tiles) {
      const image = this.add.sprite(
        tile.px[0] - (levelWidth / 2),
        tile.px[1] - (levelHeight / 2),
        textureKey,
      ).setOrigin(0, 0)
        .setTexture(textureKey)
        .setFrame(this.getLobbyTileFrame(tile.src[0], tile.src[1]));
      lobbyMap.add(image);
    }

    this.lobbyMap = lobbyMap;
    this.syncSnapshot(this.state.snapshot);
  }

  private buildMatchMap(textureKeys: Map<string, string>) {
    if (!this.matchLayout || this.matchMapParts.length > 0) {
      return;
    }

    const levelWidth = this.matchLayout.width * this.matchLayout.gridSize;
    const levelHeight = this.matchLayout.height * this.matchLayout.gridSize;
    const background = this.add.rectangle(0, 0, levelWidth, levelHeight, 0xbfe7ff).setOrigin(0.5).setDepth(-1).setVisible(false);
    this.matchMapParts.push(background);
    const layerCount = this.matchLayout.layers.length;

    // Rebuild each authored tile layer separately so roof tiles can sit above players.
    for (const [index, layer] of this.matchLayout.layers.entries()) {
      // LDtk exports layers top-most first, while Phaser draws larger depths on top.
      const container = this.add.container(0, 0).setDepth(layer.identifier === "CaveRoof" ? 20 + index : layerCount - index).setVisible(false);
      const textureKey = textureKeys.get(layer.tilesetPath);
      if (!textureKey) {
        continue;
      }

      for (const tile of layer.tiles) {
        const image = this.add.sprite(
          tile.px[0] - (levelWidth / 2),
          tile.px[1] - (levelHeight / 2),
          textureKey,
        ).setOrigin(0, 0)
          .setTexture(textureKey)
          .setFrame(this.getTileFrame(textureKey, this.matchLayout.gridSize, tile.src[0], tile.src[1]));
        container.add(image);
      }

      this.matchLayers.set(layer.identifier, container);
      this.matchMapParts.push(container);
    }

    this.syncSnapshot(this.state.snapshot);
  }

  private getLobbyTileFrame(srcX: number, srcY: number) {
    return this.getTileFrame("lobby-tiles", this.lobbyLayout?.gridSize ?? 16, srcX, srcY);
  }

  private getTileFrame(textureKey: string, gridSize: number, srcX: number, srcY: number) {
    const frameName = `${textureKey}-${srcX}-${srcY}`;
    const texture = this.textures.get(textureKey);
    if (!texture.has(frameName)) {
      texture.add(frameName, 0, srcX, srcY, gridSize, gridSize);
    }
    return frameName;
  }

  private setMatchMapVisible(visible: boolean) {
    for (const part of this.matchMapParts) {
      part.setVisible(visible);
    }
  }

  private setMatchMapAlpha(alpha: number) {
    for (const part of this.matchMapParts) {
      part.setAlpha(alpha);
    }
  }

  private updateMatchRoofVisibility() {
    const caveRoof = this.matchLayers.get("CaveRoof");
    if (!caveRoof || !this.matchLayout) {
      return;
    }

    if (this.state.viewMode === "spectator") {
      // Keep the cave fully visible in openday.
      caveRoof.setVisible(true);
      return;
    }

    const localPlayerId = this.state.localPlayerId;
    const localVisual = localPlayerId ? this.players.get(localPlayerId) : null;
    if (!localVisual) {
      caveRoof.setVisible(true);
      return;
    }

    const playerX = localVisual.container.x;
    const playerY = localVisual.container.y;
    const hideRoof = this.matchLayout.hideZones.some((zone) => {
      if (zone.hideLayer !== "CaveRoof") {
        return false;
      }

      // Use the authored zone rectangle directly so roof visibility follows the map data.
      return playerX >= zone.x
        && playerX < zone.x + zone.width
        && playerY >= zone.y
        && playerY < zone.y + zone.height;
    });
    caveRoof.setVisible(!hideRoof);
  }

  private resolveLocalStep(currentX: number, currentY: number, targetX: number, targetY: number, phase: WorldSnapshot["phase"]) {
    // Keep client prediction aligned with the active authoritative map in every phase.
    return phase === "lobby"
      ? resolveLobbyPosition(this.lobbyLayout, currentX, currentY, targetX, targetY)
      : resolveAuthoredPosition(this.matchLayout, currentX, currentY, targetX, targetY);
  }

  private getPlayerTexture(color: string) {
    const cached = this.playerTextureCache.get(color);
    if (cached) {
      return cached;
    }

    const source = this.textures.get("kiwi-source").getSourceImage() as HTMLImageElement | HTMLCanvasElement | null;
    if (!source) {
      return "kiwi-source";
    }

    const key = `kiwi-${color.replace(/[^a-f0-9]/gi, "") || "default"}`;
    if (this.textures.exists(key)) {
      this.playerTextureCache.set(color, key);
      return key;
    }

    const canvasTexture = this.textures.createCanvas(key, source.width, source.height);
    if (!canvasTexture) {
      return "kiwi-source";
    }
    const context = canvasTexture.getContext();
    context.clearRect(0, 0, source.width, source.height);
    context.drawImage(source, 0, 0);

    const image = context.getImageData(0, 0, source.width, source.height);
    const { r, g, b } = parseHexColor(color);
    const pastel = softenColor(r, g, b);

    for (let index = 0; index < image.data.length; index += 4) {
      const alpha = image.data[index + 3];
      if (alpha === 0) continue;

      const red = image.data[index];
      const green = image.data[index + 1];
      const blue = image.data[index + 2];

      // Only retint the red body pixels so the black outline and white background stay intact.
      if (red < 120 || red < green * 1.2 || red < blue * 1.2) {
        continue;
      }

      const base = red * 0.299 + green * 0.587 + blue * 0.114;
      // Keep the body readable, but lift shadows so the kiwi stays pastel.
      const intensity = Math.max(0.72, Math.min(1, base / 255));
      image.data[index] = Math.round(pastel.r * intensity);
      image.data[index + 1] = Math.round(pastel.g * intensity);
      image.data[index + 2] = Math.round(pastel.b * intensity);
    }

    context.putImageData(image, 0, 0);
    canvasTexture.refresh();
    this.playerTextureCache.set(color, key);
    return key;
  }
}

function parseHexColor(color: string) {
  const hex = color.replace("#", "");
  const normalized = hex.length === 3 ? hex.split("").map((ch) => ch + ch).join("") : hex.padEnd(6, "0").slice(0, 6);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16) || 255,
    g: Number.parseInt(normalized.slice(2, 4), 16) || 255,
    b: Number.parseInt(normalized.slice(4, 6), 16) || 255,
  };
}

function softenColor(r: number, g: number, b: number) {
  // Blend the base color toward white so the skin reads brighter on the tiny sprite.
  return {
    r: Math.round(r + (255 - r) * 0.3),
    g: Math.round(g + (255 - g) * 0.3),
    b: Math.round(b + (255 - b) * 0.3),
  };
}
