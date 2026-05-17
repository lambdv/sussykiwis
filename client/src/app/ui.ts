import { deriveHudState } from "../core/selectors";
import { ClientSession, type ClientSessionState } from "../core/session";
import { createPuzzleModal } from "../game/puzzles/puzzleModal";
import { createMeetingOverlay } from "../game/ui/meetingOverlay";

export function createAppUi(session: ClientSession) {
  const root = document.createElement("div");
  root.className = "app-ui";

  const modal = document.createElement("div");
  modal.className = "route-modal";
  const modalCard = document.createElement("div");
  modalCard.className = "route-card";
  const modalTitle = document.createElement("div");
  modalTitle.className = "route-title";
  const modalBody = document.createElement("div");
  modalBody.className = "route-body";
  const primaryButton = document.createElement("button");
  primaryButton.className = "primary-button";
  const secondaryButton = document.createElement("button");
  secondaryButton.className = "secondary-button";
  modalCard.append(modalTitle, modalBody, primaryButton, secondaryButton);
  modal.appendChild(modalCard);

  const status = document.createElement("div");
  status.className = "status-panel";
  const spectator = document.createElement("div");
  spectator.className = "spectator-panel";
  const actions = document.createElement("div");
  actions.className = "action-panel";
  const ejectionBanner = document.createElement("div");
  ejectionBanner.className = "ejection-banner";
  root.append(modal, status, spectator, actions, ejectionBanner);
  document.body.appendChild(root);

  const reportButton = createActionButton("Report");
  const killButton = createActionButton("Kill");
  const lightsButton = createActionButton("Lights");
  const grayButton = createActionButton("Gray");
  const puzzleButton = createActionButton("Puzzle");
  actions.append(reportButton, killButton, lightsButton, grayButton, puzzleButton);

  const puzzleModal = createPuzzleModal({
    onCancel: () => session.cancelPuzzle(),
    onTap: () => session.puzzleTap(),
    onConnect: (fromIndex, toIndex) => session.puzzleConnect(fromIndex, toIndex),
  });

  const meetingOverlay = createMeetingOverlay({
    getLocalPlayerId: () => session.getState().localPlayerId,
    getReadOnly: () => session.getState().viewMode === "spectator",
    onVote: (target) => session.vote(target),
    onSendChat: (message) => session.sendMeetingChat(message),
  });
  const routeRefreshTimer = window.setInterval(() => {
    renderRoute(session.getState());
  }, 250);

  const unsubscribe = session.subscribe((state) => {
    renderRoute(state);
    renderWorldPanels(state);
    meetingOverlay.update({ snapshot: state.snapshot, notice: state.notice });
  });

  function renderRoute(state: ClientSessionState) {
    modal.style.display = "none";
    primaryButton.style.display = "none";
    secondaryButton.style.display = "none";
    primaryButton.onclick = null;
    secondaryButton.onclick = null;

    if (state.route === "menu") {
      modal.style.display = "flex";
      modalTitle.textContent = "SUSSY KIWIS";
      modalBody.textContent = "Top-down Phaser client. Join the round and find the imposter.";
      primaryButton.style.display = "inline-flex";
      primaryButton.textContent = "Play";
      primaryButton.onclick = () => {
        void session.joinPlayer();
      };
      return;
    }

    if (state.route === "queue") {
      modal.style.display = "flex";
      modalTitle.textContent = state.viewMode === "spectator" ? "Joining server view..." : "Joining game...";
      modalBody.textContent = state.notice;
      return;
    }

    if (state.route === "roleAssignment") {
      modal.style.display = "flex";
      modalTitle.textContent = formatRoleName(state.localRole);
      modalBody.textContent = `${formatRoleObjective(state.localRole)}${formatRevealCountdown(state.revealEndsAt)}`;
      return;
    }

    if (state.route === "win" && state.win) {
      modal.style.display = "flex";
      modalTitle.textContent = state.win.winner === "crew" ? "Crewmates Win" : "Imposters Win";
      modalBody.textContent = state.win.reason;
      primaryButton.style.display = "inline-flex";
      primaryButton.textContent = "Back to Lobby";
      primaryButton.onclick = () => session.continueFromWin();
      secondaryButton.style.display = "inline-flex";
      secondaryButton.textContent = "Main Menu";
      secondaryButton.onclick = () => session.showMenu();
    }
  }

  function renderWorldPanels(state: ClientSessionState) {
    const hud = deriveHudState(state.snapshot, state.localPlayerId, state.localRole);
    const localPlayer = hud.localPlayer;
    const lobbyStatus = state.snapshot ? formatLobbyStatus(state.snapshot) : null;
    const isLobby = state.snapshot?.phase === "lobby";

    status.style.display = state.route === "world" || state.route === "roleAssignment" || state.route === "win"
      ? "block"
      : "none";
    status.innerHTML = [
      `<strong>Mode:</strong> ${state.viewMode}`,
      state.snapshot ? `<strong>Phase:</strong> ${state.snapshot.phase}` : "",
      !isLobby ? `<strong>Role:</strong> ${state.localRole ?? "pending"}` : "",
      !isLobby && localPlayer ? `<strong>Tasks:</strong> ${localPlayer.completedPuzzleCount}/${localPlayer.totalPuzzleCount}` : "",
      lobbyStatus ?? state.notice,
    ].filter(Boolean).join("<br />");

    import QRCode from "qrcode";
    
    spectator.style.display = state.viewMode === "spectator" && state.snapshot ? "block" : "none";
    if (state.viewMode === "spectator" && state.snapshot) {
      spectator.innerHTML = `<strong>Scan to Join!</strong><br /><canvas id="qrCanvas"></canvas><br /><strong>Joined players</strong><br />${state.snapshot.players.map((player) => player.name).join("<br />")}`;
      const joinUrl = window.location.origin;
      setTimeout(() => {
        const canvas = document.getElementById("qrCanvas") as HTMLCanvasElement;
        if (canvas) {
          QRCode.toCanvas(canvas, joinUrl, { margin: 1, width: 200 }, (error: any) => {
            if (error) console.error(error);
          });
        }
      }, 0);
    }

    actions.style.display = state.viewMode === "player" && state.route === "world" && !isLobby ? "flex" : "none";
    setButtonState(reportButton, hud.canReport, "Report", () => {
      if (hud.nearbyBody) {
        session.reportBody(hud.nearbyBody.id);
      }
    });
    setButtonState(
      killButton,
      hud.canKill,
      hud.killCooldownRemainingSeconds > 0 ? `Kill (${hud.killCooldownRemainingSeconds}s)` : "Kill",
      () => {
        if (hud.nearbyTarget) {
          session.kill(hud.nearbyTarget.id);
        }
      },
    );
    setButtonState(lightsButton, hud.canSabotage, "Lights", () => session.sabotage("lights_off"));
    setButtonState(grayButton, hud.canSabotage, "Gray", () => session.sabotage("gray_players"));
    setButtonState(
      puzzleButton,
      Boolean(hud.canWorkPuzzle && hud.nearbyPuzzle && !hud.activePuzzle),
      hud.activePuzzle ? "Puzzle Active" : hud.nearbyPuzzle ? `Use ${hud.nearbyPuzzle.kind}` : "Puzzle",
      () => {
        if (hud.nearbyPuzzle) {
          session.startPuzzle(hud.nearbyPuzzle.id);
        }
      },
    );

    const activePuzzle = state.snapshot?.puzzleStations.find((station) => station.occupiedBy === state.localPlayerId) ?? null;
    puzzleModal.update({ station: activePuzzle, player: localPlayer });

    ejectionBanner.style.display = state.ejectionMessage ? "block" : "none";
    ejectionBanner.textContent = state.ejectionMessage ?? "";
  }

  return {
    dispose() {
      window.clearInterval(routeRefreshTimer);
      unsubscribe();
      puzzleModal.dispose();
      meetingOverlay.dispose();
      root.remove();
    },
  };
}

function createActionButton(label: string) {
  const button = document.createElement("button");
  button.className = "action-button";
  button.textContent = label;
  return button;
}

function setButtonState(button: HTMLButtonElement, enabled: boolean, label: string, onPress: () => void) {
  button.textContent = label;
  button.disabled = !enabled;
  button.onclick = enabled ? onPress : null;
}

function formatRoleName(role: string | null) {
  if (!role) return "Preparing role reveal";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatRoleObjective(role: string | null) {
  switch (role) {
    case "imposter":
      return "Blend in, sabotage the crew, and secure parity.";
    case "sheriff":
      return "Complete tasks and use your kill carefully.";
    case "crewmate":
      return "Complete tasks, report bodies, and find the imposters.";
    default:
      return "Syncing with the server.";
  }
}

function formatRevealCountdown(revealEndsAt: number | null) {
  if (revealEndsAt === null) {
    return "";
  }

  const secondsLeft = Math.max(0, Math.ceil((revealEndsAt - Date.now()) / 1000));
  return ` Gameplay starts in ${secondsLeft}s.`;
}

function formatLobbyStatus(snapshot: NonNullable<ClientSessionState["snapshot"]>) {
  if (snapshot.phase !== "lobby") {
    return null;
  }

  const playersNeeded = Math.max(0, snapshot.expectedPlayers - snapshot.joinedPlayers);
  if (playersNeeded > 0) {
    return `Waiting for players: ${snapshot.joinedPlayers}/${snapshot.expectedPlayers} joined. ${playersNeeded} more needed to start.`;
  }

  if (snapshot.lobbyCountdownEndsAt === null) {
    return `Lobby full: ${snapshot.joinedPlayers}/${snapshot.expectedPlayers}. Waiting for start timer.`;
  }

  const secondsLeft = Math.max(0, Math.ceil((snapshot.lobbyCountdownEndsAt - snapshot.serverTime) / 1000));
  return `Lobby full: ${snapshot.joinedPlayers}/${snapshot.expectedPlayers}. Match starts in ${secondsLeft}s.`;
}
