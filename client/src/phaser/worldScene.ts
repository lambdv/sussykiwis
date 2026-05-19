import Phaser from "phaser";
import { PlayerInputController } from "../core/inputController";
import {
  canLocallyMove,
  getFacingFromMovement,
  getMapHalfExtent,
  predictLocalPlayer,
  reconcileLocalPlayer,
  updateRenderTime,
  type PendingInput,
  type RemoteSnapshot,
} from "../core/movement";
import { ClientSession, type ClientSessionState } from "../core/session";
import type { PuzzleKind, SnapshotDeadBody, SnapshotPlayer, WorldSnapshot } from "../networking/message";

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
  body: Phaser.GameObjects.Rectangle;
};

type PuzzleVisual = {
  container: Phaser.GameObjects.Container;
  ring: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  miniPuzzle: Phaser.GameObjects.Graphics;
};

type BorrowVisual = {
  container: Phaser.GameObjects.Container;
  ring: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
};

export class WorldScene extends Phaser.Scene {
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

  constructor(session: ClientSession) {
    super("world");
    this.session = session;
    this.state = session.getState();
  }

  create() {
    // Keep a single top-down scene alive while overlays swap around it.
    this.cameras.main.setBackgroundColor("#08111f");
    this.arena = this.add.graphics();
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
      this.players.clear();
      this.bodies.clear();
      this.puzzles.clear();
      this.borrows.clear();
    });
  }

  preload() {
    // Load the shared kiwi source sprite once, then recolor it per player in memory.
    this.load.image("kiwi-source", "/assets/2d/kwi.png");
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
      return;
    }

    this.drawArena(snapshot);
    this.syncPlayers(snapshot);
    this.syncBodies(snapshot.deadBodies);
    this.syncPuzzles(snapshot);
    this.syncBorrows(snapshot);
  }

  private drawArena(snapshot: WorldSnapshot) {
    // Determine the map boundaries. We add a visual padding of 4 units (64 pixels)
    // so that when the player reaches the map's boundary, the rendered borders are
    // further away from their position, avoiding a cramped feeling at the edges.
    const mapHalfExtent = snapshot.mapHalfExtent;
    const visualPadding = 4;
    const drawExtent = mapHalfExtent + visualPadding;
    
    // Choose floor/border colors depending on active sabotages and game phase.
    const lightsOff = snapshot.activeSabotages.some((sabotage) => sabotage.kind === "lights_off");
    const baseColor = lightsOff ? 0x05070b : snapshot.phase === "lobby" ? 0x102e1c : 0x10263a;
    const borderColor = lightsOff ? 0xf8fafc : snapshot.phase === "lobby" ? 0xf6bd60 : 0x7dd3fc;

    // Draw the arena background and outer border boundaries with the visual padding.
    this.arena.clear();
    this.arena.fillStyle(baseColor, 1);
    if (snapshot.phase === "lobby") {
      this.arena.fillCircle(0, 0, drawExtent * 16);
    } else {
      this.arena.fillRect(-drawExtent * 16, -drawExtent * 16, drawExtent * 32, drawExtent * 32);
    }
    this.arena.lineStyle(6, borderColor, 1);
    if (snapshot.phase === "lobby") {
      this.arena.strokeCircle(0, 0, drawExtent * 16);
    } else {
      this.arena.strokeRect(-drawExtent * 16, -drawExtent * 16, drawExtent * 32, drawExtent * 32);
    }

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
        const reconciled = reconcileLocalPlayer(
          player,
          this.pendingInputs,
          this.session.getMoveSpeed(),
          snapshot.mapHalfExtent,
          snapshot.phase,
        );
        visual.container.setPosition(reconciled.x * 16, reconciled.y * 16);
        if (visual.lastInputFacingLeft !== null) {
          visual.facingLeft = visual.lastInputFacingLeft;
        } else {
          visual.facingLeft = reconciled.facingLeft;
        }
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
    // Keep the pre-match lobby visually empty so gameplay stations only appear once the live round starts.
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
            const angle = station.projection.dialAngle;
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
        getMapHalfExtent(snapshot),
        snapshot.phase,
      );

visual.container.setPosition(predicted.x * 16, predicted.y * 16);
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
      visual.sprite.setFlipX(visual.facingLeft);
      visual.sprite.setY(-hop * 6);
      visual.sprite.setScale(0.9 - hop * 0.08, 0.9 + hop * 0.08);
    }
  }

  private updateCamera(snapshot: WorldSnapshot) {
    const mapHalfExtent = snapshot.mapHalfExtent;
    const visualPadding = 4;
    const drawExtent = mapHalfExtent + visualPadding;

    if (this.state.viewMode === "spectator") {
      // Spectator camera is centered on the map and zoomed to fit the padded arena perfectly.
      this.cameras.main.stopFollow();
      this.cameras.main.centerOn(0, 0);
      this.cameras.main.setZoom(Math.max(0.45, Math.min(1.1, 720 / (drawExtent * 32))));
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
      const zoom = Math.max(zoomX, zoomY);

      this.cameras.main.setZoom(zoom);
    }
  }

  private upsertPlayer(player: SnapshotPlayer) {
    const existing = this.players.get(player.id);
    if (existing) {
      existing.label.setText(player.name);
      existing.sprite.setTexture(this.getPlayerTexture(player.color));
      return existing;
    }

    const sprite = this.add.sprite(0, 0, this.getPlayerTexture(player.color)).setScale(0.9);
    const label = this.add.text(0, -28, player.name, {
      fontFamily: "Arial, sans-serif",
      fontSize: "14px",
      color: "#f8fafc",
      stroke: "#020617",
      strokeThickness: 4,
      align: "center",
    }).setOrigin(0.5);
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
    const body = this.add.rectangle(0, 0, 26, 14, 0xff5d73).setRotation(Math.PI / 8).setDepth(4);
    const visual = { body };
    this.bodies.set(id, visual);
    return visual;
  }

  private createPuzzle(id: string, kind: PuzzleKind) {
    const ring = this.add.circle(0, 0, 16, 0x111827, 0.9).setStrokeStyle(4, kind === "timer" ? 0xc084fc : 0x38bdf8, 1);
    const label = this.add.text(0, 0, kind === "timer" ? "T" : "W", {
      fontFamily: "Arial, sans-serif",
      fontSize: "14px",
      color: "#e2e8f0",
    }).setOrigin(0.5);
    
    // An optional mini puzzle view for spectators
    const miniPuzzle = this.add.graphics({ x: 0, y: -30 }).setAlpha(0);
    const container = this.add.container(0, 0, [ring, label, miniPuzzle]).setDepth(6);
    const visual = { container, ring, label, miniPuzzle };
    this.puzzles.set(id, visual);
    return visual;
  }

  private createBorrow(id: string) {
    const ring = this.add.circle(0, 0, 13, 0x7c3aed, 0.95).setStrokeStyle(4, 0xf5d0fe, 1);
    const label = this.add.text(0, 0, "KB", {
      fontFamily: "Arial, sans-serif",
      fontSize: "12px",
      color: "#f8fafc",
    }).setOrigin(0.5);
    const container = this.add.container(0, 0, [ring, label]).setDepth(7);
    const visual = { container, ring, label };
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
      const intensity = Math.max(0.35, Math.min(1, base / 255));
      image.data[index] = Math.round(r * intensity);
      image.data[index + 1] = Math.round(g * intensity);
      image.data[index + 2] = Math.round(b * intensity);
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
