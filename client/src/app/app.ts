import Phaser from "phaser";
import { ClientSession, type AppRoute } from "../core/session";
import { WorldScene } from "../phaser/worldScene";
import { createAppUi } from "./ui";
import type { BootstrapRoute } from "./bootstrapRoute";

export class App {
  private session = new ClientSession();
  private ui: ReturnType<typeof createAppUi>;
  private game: Phaser.Game;

  constructor(parent: HTMLElement, initialRoute: AppRoute | BootstrapRoute) {
    // Keep the renderer focused on the world while the session and DOM own app flow.
    const worldScene = new WorldScene(this.session);
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      backgroundColor: "#08111f",
      scene: [worldScene],
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: parent.clientWidth || window.innerWidth,
        height: parent.clientHeight || window.innerHeight,
      },
      render: {
        antialias: true,
        pixelArt: false,
      },
      disableContextMenu: true,
      banner: false,
    });

    // Resume web audio on first user gesture so mobile/Chrome audio can start.
    const unlockAudio = () => {
      const sound = this.game.sound as { context?: AudioContext; unlock?: () => void } | undefined;
      sound?.unlock?.();
      void sound?.context?.resume()?.catch(() => {});
    };

    window.addEventListener("pointerdown", unlockAudio, { once: true, passive: true });
    window.addEventListener("keydown", unlockAudio, { once: true });
    window.addEventListener("touchstart", unlockAudio, { once: true, passive: true });

    this.ui = createAppUi(this.session);

    if (initialRoute === "openday") {
      window.requestAnimationFrame(() => {
        void this.session.joinSpectator();
      });
    } else if (initialRoute === "root") {
      window.requestAnimationFrame(() => {
        void this.session.joinPlayer();
      });
    } else if (initialRoute === "menu") {
      this.session.showMenu();
    }
  }

  dispose() {
    this.ui.dispose();
    this.session.dispose();
    this.game.destroy(true);
  }
}
