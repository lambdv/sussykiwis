import { Color4, Engine, Scene, WebGPUEngine } from "@babylonjs/core";
import { NetworkClient } from "../../networking/client";
import type { ServerMessage, WorldSnapshot } from "../../networking/message";

type MeetingSceneState = {
  snapshot: WorldSnapshot | null;
  notice: string;
};

export async function createMeetingScene(
  engine: Engine | WebGPUEngine,
  _canvas: HTMLCanvasElement,
  network: NetworkClient,
  localPlayerId: string | null,
  callbacks: { onResolved: (next: "game" | "ejected" | "noEjection" | "win") => void },
): Promise<Scene> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.14, 0.12, 0.2, 1);

  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.zIndex = "30";
  root.style.background = "linear-gradient(180deg, rgba(16,18,30,0.94), rgba(32,20,36,0.96))";
  root.style.color = "white";
  root.style.padding = "16px";
  root.style.fontFamily = "system-ui, sans-serif";
  root.style.display = "grid";
  root.style.gridTemplateColumns = "1.2fr 0.8fr";
  root.style.gap = "12px";

  const state: MeetingSceneState = { snapshot: null, notice: "Meeting started" };

  const left = document.createElement("div");
  left.style.display = "flex";
  left.style.flexDirection = "column";
  left.style.gap = "12px";

  const right = document.createElement("div");
  right.style.display = "flex";
  right.style.flexDirection = "column";
  right.style.gap = "12px";

  const title = document.createElement("div");
  title.textContent = "Voting Meeting";
  title.style.fontSize = "28px";
  title.style.fontWeight = "800";

  const status = document.createElement("div");
  const roster = document.createElement("div");
  const chat = document.createElement("div");
  const input = document.createElement("textarea");
  const send = document.createElement("button");

  input.placeholder = "Send a chat message";
  input.rows = 3;
  send.textContent = "Send";
  send.onclick = () => {
    const message = input.value.trim();
    if (!message) return;
    network.sendMessage({ type: "meeting_chat", message });
    input.value = "";
  };

  left.append(title, status, roster);
  right.append(chat, input, send);
  root.append(left, right);
  document.body.appendChild(root);

  const offMessage = network.onMessage((message) => {
    handleMessage(message, state, status, roster, chat, localPlayerId, callbacks, network);
  });

  scene.onDisposeObservable.add(() => {
    offMessage();
    root.remove();
  });

  return scene;
}

function handleMessage(
  message: ServerMessage,
  state: MeetingSceneState,
  status: HTMLDivElement,
  roster: HTMLDivElement,
  chat: HTMLDivElement,
  localPlayerId: string | null,
  callbacks: { onResolved: (next: "game" | "ejected" | "noEjection" | "win") => void },
  network: NetworkClient,
) {
  if (message.type === "world_snapshot") {
    state.snapshot = message.snapshot;
    renderScene(state, status, roster, chat, localPlayerId, network);
  }

  if (message.type === "vote_update" && state.snapshot?.meeting) {
    state.notice = `Votes ${message.votesCast}/${message.totalVoters}`;
    renderScene(state, status, roster, chat, localPlayerId, network);
  }

  if (message.type === "ejection_result") {
    callbacks.onResolved(message.playerId ? "ejected" : "noEjection");
  }

  if (message.type === "win") {
    callbacks.onResolved("win");
  }

  if (message.type === "meeting_chat" && state.snapshot?.phase === "meeting") {
    state.snapshot.meeting?.chat.push({
      playerId: message.playerId,
      name: message.name,
      message: message.message,
      serverTime: message.serverTime,
    });
    renderScene(state, status, roster, chat, localPlayerId, network);
  }
}

function renderScene(state: MeetingSceneState, status: HTMLDivElement, roster: HTMLDivElement, chat: HTMLDivElement, localPlayerId: string | null, network: NetworkClient) {
  const snapshot = state.snapshot;
  if (!snapshot?.meeting) return;

  status.innerHTML = `<strong>Votes</strong> ${snapshot.meeting.votesCast}/${snapshot.meeting.totalVoters}<br />${state.notice}`;

  roster.replaceChildren();
  for (const player of snapshot.players.filter((entry) => entry.state === "alive")) {
    const row = document.createElement("div");
    row.style.padding = "8px";
    row.style.marginBottom = "6px";
    row.style.borderRadius = "8px";
    row.style.background = "rgba(255,255,255,0.08)";

    const label = document.createElement("div");
    label.textContent = `${player.name}${player.id === localPlayerId ? " (you)" : ""}`;

    const vote = snapshot.meeting.voteCounts.find((entry) => entry.target === player.id);
    const voteLabel = document.createElement("div");
    voteLabel.textContent = `${vote?.votes ?? 0} votes`;

    const button = document.createElement("button");
    button.textContent = "Vote";
    button.onclick = () => network.sendMessage({ type: "vote", target: player.id });

    row.append(label, voteLabel, button);
    roster.appendChild(row);
  }

  const skip = snapshot.meeting.voteCounts.find((entry) => entry.target === null);
  const skipRow = document.createElement("div");
  skipRow.textContent = `Skip - ${skip?.votes ?? 0} votes`;
  const skipButton = document.createElement("button");
  skipButton.textContent = "Skip Vote";
  skipButton.onclick = () => network.sendMessage({ type: "vote", target: "skip" });
  skipRow.appendChild(skipButton);
  roster.appendChild(skipRow);

  chat.replaceChildren();
  for (const message of snapshot.meeting.chat) {
    const line = document.createElement("div");
    line.textContent = `${message.name}: ${message.message}`;
    line.style.padding = "6px 0";
    chat.appendChild(line);
  }
}
