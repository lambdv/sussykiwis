import type { Faction, PlayerRole, ServerMessage, WelcomeMessage, WorldSnapshot } from "../networking/message";
import { NetworkClient } from "../networking/client";

export type AppRoute = "menu" | "queue" | "world" | "roleAssignment" | "win";
export type ViewMode = "player" | "spectator";

export type WinViewState = {
  snapshot: WorldSnapshot;
  winner: Faction;
  reason: string;
};

export type ClientSessionState = {
  route: AppRoute;
  viewMode: ViewMode;
  connected: boolean;
  notice: string;
  localPlayerId: string | null;
  localRole: PlayerRole | null;
  snapshot: WorldSnapshot | null;
  revealEndsAt: number | null;
  ejectionMessage: string | null;
  win: WinViewState | null;
};

type SessionListener = (state: ClientSessionState) => void;

export class ClientSession {
  private network = new NetworkClient();
  private listeners = new Set<SessionListener>();
  private state: ClientSessionState = {
    route: "menu",
    viewMode: "player",
    connected: false,
    notice: "Ready",
    localPlayerId: null,
    localRole: null,
    snapshot: null,
    revealEndsAt: null,
    ejectionMessage: null,
    win: null,
  };
  private joinToken = 0;
  private revealTimer: number | null = null;
  private ejectionTimer: number | null = null;
  private joinRetryTimer: number | null = null;
  private hasShownRoleReveal = false;
  private previousSubState: WorldSnapshot["subState"] | null = null;
  private reconnectViewMode: ViewMode | null = null;

  constructor() {
    this.network.onMessage((message) => {
      this.handleMessage(message);
    });

    this.network.onDisconnect((wasIntentional) => {
      this.patchState({ connected: false, notice: "Disconnected from server" });

      // Retry the same join path automatically after an unexpected drop.
      if (!wasIntentional && this.reconnectViewMode) {
        this.startJoinLoop(this.reconnectViewMode);
      }
    });
  }

  getState() {
    return this.state;
  }

  subscribe(listener: SessionListener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  showMenu() {
    this.joinToken += 1;
    this.clearTransientTimers();
    this.network.disconnect();
    this.reconnectViewMode = null;
    this.hasShownRoleReveal = false;
    this.previousSubState = null;
    this.state = {
      route: "menu",
      viewMode: "player",
      connected: false,
      notice: "Ready",
      localPlayerId: null,
      localRole: null,
      snapshot: null,
      revealEndsAt: null,
      ejectionMessage: null,
      win: null,
    };
    this.emit();
  }

  async joinPlayer() {
    this.startJoinLoop("player");
  }

  async joinSpectator() {
    this.startJoinLoop("spectator");
  }

  private startJoinLoop(viewMode: ViewMode) {
    this.joinToken += 1;
    const token = this.joinToken;
    this.clearJoinRetryTimer();
    this.clearTransientTimers();
    this.network.disconnect();
    this.reconnectViewMode = viewMode;
    this.hasShownRoleReveal = viewMode === "spectator";
    this.previousSubState = null;
    this.patchState({
      route: "queue",
      viewMode,
      connected: false,
      notice: viewMode === "spectator" ? "Joining openday..." : "Joining game...",
      localPlayerId: null,
      localRole: null,
      snapshot: null,
      revealEndsAt: null,
      ejectionMessage: null,
      win: null,
    });

    void this.tryJoin(viewMode, token, 0);
  }

  continueFromWin() {
    this.clearTransientTimers();
    this.patchState({ route: this.state.connected ? "world" : "menu", win: null, ejectionMessage: null });
  }

  nextInputSeq() {
    return this.network.nextInputSeq();
  }

  getMoveSpeed() {
    return this.network.getMoveSpeed();
  }

  sendInput(seq: number, moveX: number, moveY: number) {
    this.network.sendMessage({ type: "input", seq, moveX, moveY });
  }

  reportBody(bodyId: string) {
    this.network.sendMessage({ type: "report_body", bodyId });
  }

  kill(targetId: string) {
    this.network.sendMessage({ type: "kill", targetId });
  }

  sabotage(kind: "lights_off" | "gray_players") {
    this.network.sendMessage({ type: "sabotage", kind });
  }

  startPuzzle(stationId: string) {
    this.network.sendMessage({ type: "start_puzzle", stationId });
  }

  cancelPuzzle() {
    this.network.sendMessage({ type: "cancel_puzzle" });
  }

  puzzleTap() {
    this.network.sendMessage({ type: "puzzle_tap" });
  }

  puzzleSolved() {
    this.network.sendMessage({ type: "puzzle_solved" });
  }

  puzzleConnect(fromIndex: number, toIndex: number) {
    this.network.sendMessage({ type: "puzzle_connect", fromIndex, toIndex });
  }

  enterBorrow(borrowId: string) {
    this.network.sendMessage({ type: "enter_borrow", borrowId });
  }

  traverseBorrow(direction: "up" | "down" | "left" | "right") {
    this.network.sendMessage({ type: "traverse_borrow", direction });
  }

  exitBorrow() {
    this.network.sendMessage({ type: "exit_borrow" });
  }

  vote(target: string | "skip") {
    this.network.sendMessage({ type: "vote", target });
  }

  sendMeetingChat(message: string) {
    return this.network.sendMessage({ type: "meeting_chat", message });
  }

  dispose() {
    this.clearTransientTimers();
    this.reconnectViewMode = null;
    this.network.disconnect();
    this.listeners.clear();
  }

  private applyWelcome(welcome: WelcomeMessage, viewMode: ViewMode) {
    this.clearJoinRetryTimer();
    this.patchState({
      route: "world",
      viewMode,
      connected: true,
      notice: welcome.observer ? "Connected as observer" : "Connected",
      localPlayerId: welcome.observer ? null : welcome.playerId,
      localRole: null,
    });
  }

  private async tryJoin(viewMode: ViewMode, token: number, attempt: number) {
    if (token !== this.joinToken) return;

    const attemptLabel = attempt === 0 ? "" : ` (retry ${attempt})`;
    this.patchState({
      notice: viewMode === "spectator" ? `Joining openday...${attemptLabel}` : `Joining game...${attemptLabel}`,
    });

    try {
      const welcome = await this.network.join(
        viewMode === "spectator"
          ? { name: "Spectator", spectator: true, timeoutMs: 8000 }
          : { timeoutMs: 8000 },
      );

      if (token !== this.joinToken) return;
      this.applyWelcome(welcome, viewMode);
    } catch (error) {
      if (token !== this.joinToken) return;

      console.warn(viewMode === "spectator" ? "Failed to join openday" : "Failed to join game", error);

      const delay = Math.min(1000 * Math.pow(2, Math.min(attempt + 1, 4)), 10000);
      this.patchState({
        notice:
          viewMode === "spectator"
            ? `Joining openday... retrying in ${Math.ceil(delay / 1000)}s`
            : `Joining game... retrying in ${Math.ceil(delay / 1000)}s`,
      });

      this.clearJoinRetryTimer();
      this.joinRetryTimer = window.setTimeout(() => {
        this.joinRetryTimer = null;
        void this.tryJoin(viewMode, token, attempt + 1);
      }, delay);
    }
  }

  private handleMessage(message: ServerMessage) {
    switch (message.type) {
      case "welcome":
        this.patchState({
          connected: true,
          notice: message.observer ? "Connected as observer" : "Connected",
          localPlayerId: message.observer ? null : message.playerId,
        });
        break;

      case "join_rejected":
        this.patchState({ notice: message.reason });
        break;

      case "game_started":
        this.patchState({ localRole: message.role, notice: `Role: ${message.role}` });
        break;

      case "meeting_started":
        this.patchState({ route: "world", notice: `Meeting called for ${message.reportedBodyId.slice(0, 6)}` });
        break;

      case "vote_update":
        this.patchState({ notice: `Votes: ${message.votesCast}/${message.totalVoters}` });
        break;

      case "meeting_chat":
        this.patchState({ notice: `${message.name}: ${message.message}` });
        break;

      case "ejection_result":
        this.showEjectionMessage(
          message.playerId
            ? `${message.playerId.slice(0, 6)} ejected${message.wasImposter ? " (imposter)" : ""}`
            : "No one was ejected",
        );
        break;

      case "win":
        if (this.state.snapshot) {
          this.patchState({
            route: "win",
            notice: `${message.winner} win: ${message.reason}`,
            win: {
              snapshot: this.state.snapshot,
              winner: message.winner,
              reason: message.reason,
            },
          });
        }
        break;

      case "world_snapshot":
        this.handleSnapshot(message.snapshot);
        break;
    }
  }

  private handleSnapshot(snapshot: WorldSnapshot) {
    const nextRole = this.state.localRole ?? this.findLocalRole(snapshot);

    if (snapshot.phase === "lobby") {
      this.hasShownRoleReveal = false;
    }

    if (snapshot.phase === "win" && snapshot.win) {
      this.patchState({
        route: "win",
        snapshot,
        localRole: nextRole,
        win: {
          snapshot,
          winner: snapshot.win.winner,
          reason: snapshot.win.reason,
        },
      });
      this.previousSubState = snapshot.subState;
      return;
    }

    this.patchState({
      route: this.state.route === "queue" ? "world" : this.state.route,
      snapshot,
      localRole: nextRole,
    });

    if (
      this.state.viewMode === "player"
      && nextRole
      && snapshot.subState === "in_game"
      && this.previousSubState !== "in_game"
      && !this.hasShownRoleReveal
    ) {
      this.startRoleReveal();
    }

    this.previousSubState = snapshot.subState;
  }

  private startRoleReveal() {
    this.clearRevealTimer();
    this.hasShownRoleReveal = true;
    const revealEndsAt = Date.now() + 6000;
    this.patchState({ route: "roleAssignment", revealEndsAt });
    this.revealTimer = window.setTimeout(() => {
      this.revealTimer = null;
      this.patchState({ route: "world", revealEndsAt: null });
    }, 6000);
  }

  private showEjectionMessage(message: string) {
    this.clearEjectionTimer();
    this.patchState({ route: "world", ejectionMessage: message });
    this.ejectionTimer = window.setTimeout(() => {
      this.ejectionTimer = null;
      this.patchState({ ejectionMessage: null });
    }, 4000);
  }

  private findLocalRole(snapshot: WorldSnapshot) {
    const localPlayerId = this.state.localPlayerId;
    return snapshot.players.find((player) => player.id === localPlayerId)?.role ?? null;
  }

  private patchState(patch: Partial<ClientSessionState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private clearTransientTimers() {
    this.clearRevealTimer();
    this.clearEjectionTimer();
    this.clearJoinRetryTimer();
  }

  private clearJoinRetryTimer() {
    if (this.joinRetryTimer !== null) {
      window.clearTimeout(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }
  }

  private clearRevealTimer() {
    if (this.revealTimer !== null) {
      window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
  }

  private clearEjectionTimer() {
    if (this.ejectionTimer !== null) {
      window.clearTimeout(this.ejectionTimer);
      this.ejectionTimer = null;
    }
  }
}
