import type { NetworkClient } from "../../networking/client";
import type { WorldSnapshot } from "../../networking/message";

type MeetingOverlayOptions = {
  localPlayerId: string | null;
  network: NetworkClient | null;
  readOnly: boolean;
};

type MeetingOverlayState = {
  snapshot: WorldSnapshot | null;
  notice: string;
};

export function createMeetingOverlay(options: MeetingOverlayOptions) {
  // Build one shared DOM meeting UI so player and server views stay visually aligned.
  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.zIndex = "30";
  root.style.background = "linear-gradient(180deg, rgba(16,18,30,0.94), rgba(32,20,36,0.96))";
  root.style.color = "white";
  root.style.padding = "16px";
  root.style.fontFamily = "system-ui, sans-serif";
  root.style.display = "none";
  root.style.gridTemplateColumns = "1.2fr 0.8fr";
  root.style.gap = "12px";

  const left = document.createElement("div");
  left.style.display = "flex";
  left.style.flexDirection = "column";
  left.style.gap = "12px";

  const right = document.createElement("div");
  right.style.display = "flex";
  right.style.flexDirection = "column";
  right.style.gap = "12px";

  const title = document.createElement("div");
  title.textContent = options.readOnly ? "Voting Meeting (read-only)" : "Voting Meeting";
  title.style.fontSize = "28px";
  title.style.fontWeight = "800";

  const status = document.createElement("div");
  const roster = document.createElement("div");
  const chat = document.createElement("div");
  const input = document.createElement("textarea");
  const send = document.createElement("button");

  // Keep chat visible on both variants, but only players can submit new messages.
  input.placeholder = options.readOnly ? "Read-only server view" : "Send a chat message";
  input.rows = 3;
  input.disabled = options.readOnly;
  send.textContent = options.readOnly ? "Read-only" : "Send";
  send.disabled = options.readOnly;
  send.onclick = () => {
    if (options.readOnly || !options.network) return;
    const message = input.value.trim();
    if (!message) return;
    options.network.sendMessage({ type: "meeting_chat", message });
    input.value = "";
  };

  left.append(title, status, roster);
  right.append(chat, input, send);
  root.append(left, right);
  document.body.appendChild(root);

  return {
    update(state: MeetingOverlayState) {
      // Hide the overlay outside meetings so the underlying scene can render normally.
      const snapshot = state.snapshot;
      if (!snapshot?.meeting) {
        root.style.display = "none";
        return;
      }

      root.style.display = "grid";
      const ticksLeft = Math.max(0, snapshot.meeting.endsAtTick - snapshot.tick);
      status.innerHTML = `<strong>Votes</strong> ${snapshot.meeting.votesCast}/${snapshot.meeting.totalVoters}<br /><strong>Time left</strong> ${formatMeetingTimeLeft(ticksLeft)}<br />${state.notice}`;

      roster.replaceChildren();
      for (const player of snapshot.players.filter((entry) => entry.state === "alive")) {
        const row = document.createElement("div");
        row.style.padding = "8px";
        row.style.marginBottom = "6px";
        row.style.borderRadius = "8px";
        row.style.background = "rgba(255,255,255,0.08)";

        const label = document.createElement("div");
        label.textContent = `${player.name}${player.id === options.localPlayerId ? " (you)" : ""}`;

        const vote = snapshot.meeting.voteCounts.find((entry) => entry.target === player.id);
        const voteLabel = document.createElement("div");
        voteLabel.textContent = `${vote?.votes ?? 0} votes`;

        row.append(label, voteLabel);

        if (!options.readOnly && options.network) {
          const button = document.createElement("button");
          button.textContent = "Vote";
          button.onclick = () => options.network?.sendMessage({ type: "vote", target: player.id });
          row.appendChild(button);
        }

        roster.appendChild(row);
      }

      const skip = snapshot.meeting.voteCounts.find((entry) => entry.target === null);
      const skipRow = document.createElement("div");
      skipRow.textContent = `Skip - ${skip?.votes ?? 0} votes`;

      if (!options.readOnly && options.network) {
        const skipButton = document.createElement("button");
        skipButton.textContent = "Skip Vote";
        skipButton.onclick = () => options.network?.sendMessage({ type: "vote", target: "skip" });
        skipRow.appendChild(skipButton);
      }

      roster.appendChild(skipRow);

      chat.replaceChildren();
      for (const message of snapshot.meeting.chat) {
        const line = document.createElement("div");
        line.textContent = `${message.name}: ${message.message}`;
        line.style.padding = "6px 0";
        chat.appendChild(line);
      }
    },

    dispose() {
      // Remove the overlay cleanly when the owning scene is disposed.
      root.remove();
    },
  };
}

function formatMeetingTimeLeft(ticksLeft: number) {
  // Meetings are tick-based on the server, so convert the remaining ticks into a simple countdown.
  const secondsLeft = Math.ceil(ticksLeft / 20);
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
