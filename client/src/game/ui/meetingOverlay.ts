import type { WorldSnapshot } from "../../networking/message";

type MeetingOverlayOptions = {
  getLocalPlayerId: () => string | null;
  getReadOnly: () => boolean;
  onVote: (target: string | "skip") => void;
  onSendChat: (message: string) => boolean;
};

type MeetingOverlayState = {
  snapshot: WorldSnapshot | null;
  notice: string;
};

export function createMeetingOverlay(options: MeetingOverlayOptions) {
  // Build one shared DOM meeting UI so player and server views stay visually aligned.
  const root = document.createElement("div");
  root.className = "meeting-overlay";

  const left = document.createElement("div");
  left.className = "meeting-column";

  const right = document.createElement("div");
  right.className = "meeting-column";

  const title = document.createElement("div");
  title.textContent = "Voting Meeting";
  title.className = "meeting-title";

  const status = document.createElement("div");
  const notice = document.createElement("div");
  const roster = document.createElement("div");
  const chat = document.createElement("div");
  const input = document.createElement("textarea");
  const send = document.createElement("button");

  const wireAction = (button: HTMLButtonElement, onActivate: () => void) => {
    // Fire on pointer down so taps are not lost on mobile browsers.
    button.style.touchAction = "manipulation";
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (button.disabled) return;
      onActivate();
    });
  };

  // Keep chat visible on both variants, but only players can submit new messages.
  input.placeholder = "Send a chat message";
  input.rows = 3;
  send.textContent = "Send";
  wireAction(send, () => {
    if (options.getReadOnly()) return;
    const message = input.value.trim();
    if (!message) return;
    if (!options.onSendChat(message)) return;
    input.value = "";
  });

  notice.className = "meeting-notice";

  left.append(title, status, notice, roster);
  right.append(chat, input, send);
  root.append(left, right);
  document.body.appendChild(root);

  return {
    update(state: MeetingOverlayState) {
      // Hide the overlay outside meetings so the underlying scene can render normally.
      const snapshot = state.snapshot;
      const readOnly = options.getReadOnly();
      const localPlayerId = options.getLocalPlayerId();

      if (!snapshot?.meeting) {
        root.style.display = "none";
        return;
      }

      root.style.display = "grid";
      title.textContent = readOnly ? "Voting Meeting (read-only)" : "Voting Meeting";
      input.placeholder = readOnly ? "Read-only server view" : "Send a chat message";
      input.disabled = readOnly;
      send.textContent = readOnly ? "Read-only" : "Send";
      send.disabled = readOnly;
      notice.textContent = state.notice;
      const ticksLeft = Math.max(0, snapshot.meeting.endsAtTick - snapshot.tick);
      status.innerHTML = `<strong>Votes</strong> ${snapshot.meeting.votesCast}/${snapshot.meeting.totalVoters}<br /><strong>Time left</strong> ${formatMeetingTimeLeft(ticksLeft)}<br />${state.notice}`;

      roster.replaceChildren();
      for (const player of snapshot.players.filter((entry) => entry.state === "alive")) {
        const row = document.createElement("div");
        row.className = "meeting-row";

        const label = document.createElement("div");
        label.textContent = player.id === localPlayerId ? "You" : "Player";

        const vote = snapshot.meeting.voteCounts.find((entry) => entry.target === player.id);
        const voteLabel = document.createElement("div");
        voteLabel.textContent = `${vote?.votes ?? 0} votes`;

        row.append(label, voteLabel);

        if (!readOnly) {
          const button = document.createElement("button");
          button.textContent = "Vote";
          wireAction(button, () => options.onVote(player.id));
          row.appendChild(button);
        }

        roster.appendChild(row);
      }

      const skip = snapshot.meeting.voteCounts.find((entry) => entry.target === null);
      const skipRow = document.createElement("div");
      skipRow.textContent = `Skip - ${skip?.votes ?? 0} votes`;

      if (!readOnly) {
        const skipButton = document.createElement("button");
        skipButton.textContent = "Skip Vote";
        wireAction(skipButton, () => options.onVote("skip"));
        skipRow.appendChild(skipButton);
      }

      roster.appendChild(skipRow);

      chat.replaceChildren();
      for (const message of snapshot.meeting.chat) {
        const line = document.createElement("div");
        line.textContent = message.message;
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
