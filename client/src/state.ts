export type GameState = "MENU" | "QUEUE" | "GAME" | "MEETING" | "EJECTED" | "NO_EJECT" | "WIN" | "GAME_END";

type StateListener = (state: GameState) => void;

class GameStateManager {
  private state: GameState = "MENU";
  private listeners: StateListener[] = [];

  get(): GameState {
    return this.state;
  }

  set(state: GameState) {
    this.state = state;
    this.listeners.forEach((fn) => fn(state));
  }

  onChange(fn: StateListener) {
    this.listeners.push(fn);
  }
}

export const gameState = new GameStateManager();
