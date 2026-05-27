import Phaser from "phaser";
import { ClientSession, type ClientSessionState } from "../core/session";
import type { PlayerRole } from "../networking/message";

type RevealVisual = {
  container: Phaser.GameObjects.Container;
  glow: Phaser.GameObjects.Arc;
  sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Arc;
  name: Phaser.GameObjects.Text;
  tag: Phaser.GameObjects.Text | null;
};

export class RoleRevealScene extends Phaser.Scene {
  private session: ClientSession;
  private state: ClientSessionState;
  private unsubscribe: (() => void) | null = null;
  private playerTextureCache = new Map<string, string>();
  private visuals: RevealVisual[] = [];
  private titleEyebrow!: Phaser.GameObjects.Text;
  private title!: Phaser.GameObjects.Text;
  private description!: Phaser.GameObjects.Text;
  private countdown!: Phaser.GameObjects.Text;
  private titleAccent!: Phaser.GameObjects.Rectangle;
  private backgroundGlow!: Phaser.GameObjects.Graphics;
  private lineupDirty = true;

  constructor(session: ClientSession) {
    super({ key: "roleReveal", active: false });
    this.session = session;
    this.state = session.getState();
  }

  preload() {
    // Load the base kiwi sprite here too so the reveal scene can render independently.
    if (!this.textures.exists("kiwi-source")) {
      this.load.image("kiwi-source", "/assets/2d/kwi.png");
    }
  }

  create() {
    this.cameras.main.setBackgroundColor("#000000");

    // Build the reveal composition once, then relayout on resize or state updates.
    this.backgroundGlow = this.add.graphics();
    this.titleAccent = this.add.rectangle(0, 0, 0, 0, 0xffffff, 1).setOrigin(0.5);
    this.titleEyebrow = this.add.text(0, 0, "YOUR ROLE", {
      fontFamily: "Arial, sans-serif",
      fontSize: "22px",
      color: "#94a3b8",
      fontStyle: "bold",
      letterSpacing: 8,
      align: "center",
    }).setOrigin(0.5);
    this.title = this.add.text(0, 0, "", {
      fontFamily: "Arial, sans-serif",
      fontSize: "64px",
      fontStyle: "bold",
      align: "center",
      stroke: "#000000",
      strokeThickness: 10,
    }).setOrigin(0.5);
    this.description = this.add.text(0, 0, "", {
      fontFamily: "Arial, sans-serif",
      fontSize: "22px",
      color: "#cbd5e1",
      align: "center",
      wordWrap: { width: 720, useAdvancedWrap: true },
      lineSpacing: 8,
    }).setOrigin(0.5);
    this.countdown = this.add.text(0, 0, "", {
      fontFamily: "Arial, sans-serif",
      fontSize: "18px",
      color: "#64748b",
      align: "center",
    }).setOrigin(0.5);

    this.unsubscribe = this.session.subscribe((state) => {
      this.state = state;
      this.lineupDirty = true;
      this.renderScene();
    });

    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
      this.clearVisuals();
      this.playerTextureCache.clear();
    });

    this.renderScene();
    this.tweens.add({
      targets: [this.titleEyebrow, this.title, this.description, this.countdown],
      alpha: { from: 0, to: 1 },
      y: "-=10",
      duration: 260,
      ease: "Cubic.Out",
    });
  }

  update() {
    this.countdown.setText(formatRevealCountdown(this.state.revealEndsAt));
  }

  private handleResize() {
    this.lineupDirty = true;
    this.renderScene();
  }

  private renderScene() {
    const { titleColor, accentColor, glowColor } = getRolePalette(this.state.localRole);
    const width = this.scale.width;
    const height = this.scale.height;
    const centerX = width / 2;
    const titleY = Math.max(72, height * 0.14);

    // Paint the background with a soft role-colored glow so the reveal feels intentional.
    this.backgroundGlow.clear();
    this.backgroundGlow.fillStyle(0x000000, 1);
    this.backgroundGlow.fillRect(0, 0, width, height);
    this.backgroundGlow.fillStyle(glowColor, 0.12);
    this.backgroundGlow.fillCircle(centerX, height * 0.42, Math.max(width * 0.16, 160));
    this.backgroundGlow.fillStyle(glowColor, 0.07);
    this.backgroundGlow.fillCircle(centerX, height * 0.82, Math.max(width * 0.24, 220));

    this.titleEyebrow.setPosition(centerX, titleY).setAlpha(1);
    this.titleAccent
      .setPosition(centerX, titleY + 28)
      .setSize(Math.min(220, width * 0.24), 6)
      .setFillStyle(accentColor, 1);
    this.title
      .setPosition(centerX, titleY + 88)
      .setText(formatRoleName(this.state.localRole).toUpperCase())
      .setColor(titleColor)
      .setFontSize(width < 700 ? 44 : 64);
    this.description
      .setPosition(centerX, titleY + 150)
      .setText(formatRoleObjective(this.state.localRole))
      .setWordWrapWidth(Math.min(width - 64, 760));
    this.countdown.setPosition(centerX, height - 48);

    if (this.lineupDirty) {
      this.layoutLineup(centerX, height);
      this.lineupDirty = false;
    }
  }

  private layoutLineup(centerX: number, height: number) {
    this.clearVisuals();

    const players = this.state.roleRevealPlayers;
    if (players.length === 0) {
      return;
    }

    const count = players.length;
    const maxSpacing = this.scale.width < 720 ? 112 : 148;
    const spacing = count <= 1 ? 0 : Math.min(maxSpacing, (this.scale.width - 96) / Math.max(1, count - 1));
    const baseY = Math.max(260, Math.min(height * 0.68, height - 170));
    const startX = centerX - ((count - 1) * spacing) / 2;
    const roleAccent = getRolePalette(this.state.localRole).accentColor;

    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      const x = startX + index * spacing;
      const isLocal = player.id === this.state.localPlayerId;
      const glow = this.add.circle(0, 0, isLocal ? 56 : 46, isLocal ? roleAccent : 0xffffff, isLocal ? 0.22 : 0.08);

      let sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Arc;
      const texture = this.getPlayerTexture(player.color);
      if (texture) {
        sprite = this.add.sprite(0, -4, texture).setDisplaySize(isLocal ? 124 : 106, isLocal ? 124 : 106);
      } else {
        sprite = this.add.circle(0, -4, isLocal ? 36 : 32, Phaser.Display.Color.HexStringToColor(player.color).color, 1);
      }

      const name = this.add.text(0, 70, player.name.toUpperCase(), {
        fontFamily: "Arial, sans-serif",
        fontSize: isLocal ? "18px" : "16px",
        color: isLocal ? "#f8fafc" : "#cbd5e1",
        fontStyle: "bold",
        align: "center",
      }).setOrigin(0.5);

      const tag = isLocal
        ? this.add.text(0, -74, "YOU", {
          fontFamily: "Arial, sans-serif",
          fontSize: "14px",
          color: colorNumberToHex(roleAccent),
          fontStyle: "bold",
          backgroundColor: "#020617",
          padding: { left: 10, right: 10, top: 5, bottom: 5 },
        }).setOrigin(0.5)
        : null;

      const container = this.add.container(x, baseY, tag ? [glow, sprite, tag, name] : [glow, sprite, name]);
      container.setDepth(10 + index);
      this.visuals.push({ container, glow, sprite, name, tag });
    }
  }

  private clearVisuals() {
    for (const visual of this.visuals) {
      visual.container.destroy(true);
    }
    this.visuals = [];
  }

  private getPlayerTexture(color: string) {
    const cached = this.playerTextureCache.get(color);
    if (cached) {
      return cached;
    }

    const source = this.textures.get("kiwi-source")?.getSourceImage() as HTMLImageElement | HTMLCanvasElement | null;
    if (!source) {
      return null;
    }

    const key = `role-reveal-kiwi-${color.replace(/[^a-f0-9]/gi, "") || "default"}`;
    if (this.textures.exists(key)) {
      this.playerTextureCache.set(color, key);
      return key;
    }

    const canvasTexture = this.textures.createCanvas(key, source.width, source.height);
    if (!canvasTexture) {
      return null;
    }

    const context = canvasTexture.getContext();
    context.clearRect(0, 0, source.width, source.height);
    context.drawImage(source, 0, 0);

    const image = context.getImageData(0, 0, source.width, source.height);
    const { r, g, b } = parseHexColor(color);
    const pastel = softenColor(r, g, b);
    for (let index = 0; index < image.data.length; index += 4) {
      const alpha = image.data[index + 3];
      if (alpha === 0) {
        continue;
      }

      const red = image.data[index];
      const green = image.data[index + 1];
      const blue = image.data[index + 2];
      if (red < 120 || red < green * 1.2 || red < blue * 1.2) {
        continue;
      }

      const base = red * 0.299 + green * 0.587 + blue * 0.114;
      const intensity = Math.max(0.72, Math.min(1, base / 255));
      image.data[index] = Math.round(pastel.r * intensity);
      image.data[index + 1] = Math.round(pastel.g * intensity);
      image.data[index + 2] = Math.round(pastel.b * intensity);
    }

    context.putImageData(image, 0, 0);
    canvasTexture.refresh();
    this.playerTextureCache.set(color, key);
    return key;
  }
}

function formatRoleName(role: PlayerRole | null) {
  if (!role) {
    return "Role";
  }
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatRoleObjective(role: PlayerRole | null) {
  switch (role) {
    case "imposter":
      return "Blend in, spot your partners, and break the crew before they finish their tasks.";
    case "sheriff":
      return "Stay with the crew, finish tasks, and use your shot carefully.";
    case "crewmate":
      return "Finish every task, report bodies fast, and identify the imposters.";
    default:
      return "Preparing the match...";
  }
}

function formatRevealCountdown(revealEndsAt: number | null) {
  if (revealEndsAt === null) {
    return "";
  }
  const secondsLeft = Math.max(0, Math.ceil((revealEndsAt - Date.now()) / 1000));
  return `Match starts in ${secondsLeft}s`;
}

function getRolePalette(role: PlayerRole | null) {
  switch (role) {
    case "imposter":
      return { titleColor: "#fb7185", accentColor: 0xfb7185, glowColor: 0x7f1d1d };
    case "sheriff":
      return { titleColor: "#fbbf24", accentColor: 0xfbbf24, glowColor: 0x713f12 };
    case "crewmate":
    default:
      return { titleColor: "#60a5fa", accentColor: 0x60a5fa, glowColor: 0x1e3a8a };
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

function softenColor(r: number, g: number, b: number) {
  return {
    r: Math.round(r + (255 - r) * 0.3),
    g: Math.round(g + (255 - g) * 0.3),
    b: Math.round(b + (255 - b) * 0.3),
  };
}

function colorNumberToHex(color: number) {
  return `#${color.toString(16).padStart(6, "0")}`;
}
