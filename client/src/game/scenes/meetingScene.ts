import { Color4, Engine, FreeCamera, Scene, Vector3, WebGPUEngine } from "@babylonjs/core";
import { NetworkClient } from "../../networking/client";
import type { ServerMessage, WorldSnapshot } from "../../networking/message";
import { createMeetingOverlay } from "../ui/meetingOverlay";

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

  // Give the meeting scene a real active camera so Babylon can keep rendering safely.
  const camera = new FreeCamera("meeting-camera", new Vector3(0, 0, -10), scene);
  scene.activeCamera = camera;

  const overlay = createMeetingOverlay({
    localPlayerId,
    network,
    readOnly: false,
  });
  const state: MeetingSceneState = { snapshot: null, notice: "Meeting started" };

  const offMessage = network.onMessage((message) => {
    handleMessage(message, state, callbacks, overlay);
  });
  const countdown = window.setInterval(() => {
    if (state.snapshot?.meeting) {
      overlay.update(state);
    }
  }, 1000);

  scene.onDisposeObservable.add(() => {
    // Clear DOM and listeners with the scene so route transitions stay clean.
    offMessage();
    window.clearInterval(countdown);
    overlay.dispose();
  });

  return scene;
}

function handleMessage(
  message: ServerMessage,
  state: MeetingSceneState,
  callbacks: { onResolved: (next: "game" | "ejected" | "noEjection" | "win") => void },
  overlay: ReturnType<typeof createMeetingOverlay>,
) {
  if (message.type === "world_snapshot") {
    state.snapshot = message.snapshot;
    overlay.update(state);
  }

  if (message.type === "vote_update" && state.snapshot?.meeting) {
    state.notice = `Votes ${message.votesCast}/${message.totalVoters}`;
    overlay.update(state);
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
    overlay.update(state);
  }
}
