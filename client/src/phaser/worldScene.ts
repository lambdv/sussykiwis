import Phaser from "phaser";
import { PlayerInputController } from "../core/inputController";
import {
  canLocallyMove,
  getFacingFromMovement,
  getMapHalfExtent,
  getRemoteRenderPosition,
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
  circle: Phaser.GameObjects.Arc;
  facing: Phaser.GameObjects.Line;
  label: Phaser.GameObjects.Text;
  snapshots: RemoteSnapshot[];
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

export class WorldScene extends Phaser.Scene {
  private session: ClientSession;
  private unsubscribe: (() => void) | null = null;
  private inputController: PlayerInputController | null = null;
  private state: ClientSessionState;
  private latestServerTime = 0;
  private renderTime = 0;
  private pendingInputs: PendingInput[] = [];
  private players = new Map<string, PlayerVisual>();
  private bodies = new Map<string, BodyVisual>();
  private puzzles = new Map<string, PuzzleVisual>();
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
    });
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
  }

  private drawArena(snapshot: WorldSnapshot) {
    const mapHalfExtent = snapshot.mapHalfExtent;
    const lightsOff = snapshot.activeSabotages.some((sabotage) => sabotage.kind === "lights_off");
    const baseColor = lightsOff ? 0x05070b : snapshot.phase === "lobby" ? 0x102e1c : 0x10263a;
    const borderColor = lightsOff ? 0xf8fafc : snapshot.phase === "lobby" ? 0xf6bd60 : 0x7dd3fc;

    this.arena.clear();
    this.arena.fillStyle(baseColor, 1);
    if (snapshot.phase === "lobby") {
      this.arena.fillCircle(0, 0, mapHalfExtent * 16);
    } else {
      this.arena.fillRect(-mapHalfExtent * 16, -mapHalfExtent * 16, mapHalfExtent * 32, mapHalfExtent * 32);
    }
    this.arena.lineStyle(6, borderColor, 1);
    if (snapshot.phase === "lobby") {
      this.arena.strokeCircle(0, 0, mapHalfExtent * 16);
    } else {
      this.arena.strokeRect(-mapHalfExtent * 16, -mapHalfExtent * 16, mapHalfExtent * 32, mapHalfExtent * 32);
    }

    this.cameras.main.setBounds(-mapHalfExtent * 16, -mapHalfExtent * 16, mapHalfExtent * 32, mapHalfExtent * 32);
  }

  private syncPlayers(snapshot: WorldSnapshot) {
    const localPlayerId = this.state.localPlayerId;
    const liveIds = new Set<string>();
    const grayPlayers = snapshot.activeSabotages.some((sabotage) => sabotage.kind === "gray_players");

    for (const player of snapshot.players) {
      liveIds.add(player.id);
      const visual = this.upsertPlayer(player);
      visual.circle.setFillStyle(grayPlayers ? 0x8e909a : Phaser.Display.Color.HexStringToColor(player.color).color);
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
        visual.container.rotation = reconciled.facing;
      } else {
        visual.snapshots.push({
          time: snapshot.serverTime,
          x: player.x * 16,
          y: player.z * 16,
          facing: player.facingYaw,
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

    if (canLocallyMove(snapshot.phase, localPlayer.state)) {
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
        visual.container.rotation = facing;
      }
      this.pendingInputs.push({ seq, moveX: input.x, moveY: input.y, dt, facing });
      if (this.pendingInputs.length > 120) {
        this.pendingInputs.shift();
      }
    }

    this.session.sendInput(seq, input.x, input.y);
  }

  private interpolateRemotePlayers() {
    for (const [id, visual] of this.players) {
      if (id === this.state.localPlayerId) continue;
      const renderPosition = getRemoteRenderPosition(visual.snapshots, this.renderTime);
      if (!renderPosition) continue;
      visual.container.setPosition(renderPosition.x, renderPosition.y);
      visual.container.rotation = renderPosition.facing;
    }
  }

  private updateCamera(snapshot: WorldSnapshot) {
    const mapHalfExtent = snapshot.mapHalfExtent;

    if (this.state.viewMode === "spectator") {
      this.cameras.main.stopFollow();
      this.cameras.main.centerOn(0, 0);
      this.cameras.main.setZoom(Math.max(0.45, Math.min(1.1, 720 / (mapHalfExtent * 32))));
      return;
    }

    const localPlayer = this.state.localPlayerId ? this.players.get(this.state.localPlayerId) : null;
    if (localPlayer) {
      this.cameras.main.startFollow(localPlayer.container, true, 0.14, 0.14);
      this.cameras.main.setZoom(1.35);
    }
  }

  private upsertPlayer(player: SnapshotPlayer) {
    const existing = this.players.get(player.id);
    if (existing) {
      existing.label.setText(player.name);
      return existing;
    }

    const circle = this.add.circle(0, 0, 14, Phaser.Display.Color.HexStringToColor(player.color).color, 1);
    const facing = this.add.line(0, 0, 0, 0, 18, 0, 0xffffff, 1).setLineWidth(3, 3);
    const label = this.add.text(0, -28, player.name, {
      fontFamily: "Arial, sans-serif",
      fontSize: "14px",
      color: "#f8fafc",
      stroke: "#020617",
      strokeThickness: 4,
      align: "center",
    }).setOrigin(0.5);
    const container = this.add.container(player.x * 16, player.z * 16, [circle, facing, label]);
    container.setDepth(10);

    const visual = { container, circle, facing, label, snapshots: [] };
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
}
