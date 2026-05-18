import nipplejs from "nipplejs";

export class PlayerInputController {
  private keys = new Set<string>();
  private joy = { x: 0, y: 0 };
  private manager: any = null;
  private joyZone: HTMLDivElement | null;
  private activePointerId: number | null = null;
  private activeTouchId: number | null = null;

  private onKeyDown = (event: KeyboardEvent) => this.keys.add(event.key);
  private onKeyUp = (event: KeyboardEvent) => this.keys.delete(event.key);
  private onPointerDown = (event: PointerEvent) => {
    this.activePointerId = event.pointerId;
    this.updateJoyFromPoint(event.clientX, event.clientY);
    this.joyZone?.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  private onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointerId) return;
    this.updateJoyFromPoint(event.clientX, event.clientY);
    event.preventDefault();
  };
  private onPointerEnd = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    this.joy.x = 0;
    this.joy.y = 0;
    event.preventDefault();
  };
  private onTouchStart = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (!touch || this.activeTouchId !== null) return;
    this.activeTouchId = touch.identifier;
    this.updateJoyFromPoint(touch.clientX, touch.clientY);
    event.preventDefault();
  };
  private onTouchMove = (event: TouchEvent) => {
    if (this.activeTouchId === null) return;
    const touch = Array.from(event.changedTouches).find((entry) => entry.identifier === this.activeTouchId);
    if (!touch) return;
    this.updateJoyFromPoint(touch.clientX, touch.clientY);
    event.preventDefault();
  };
  private onTouchEnd = (event: TouchEvent) => {
    if (this.activeTouchId === null) return;
    const touch = Array.from(event.changedTouches).find((entry) => entry.identifier === this.activeTouchId);
    if (!touch) return;
    this.activeTouchId = null;
    this.joy.x = 0;
    this.joy.y = 0;
    event.preventDefault();
  };

  constructor() {
    this.joyZone = document.getElementById("joystickZone") as HTMLDivElement | null;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    if (this.joyZone) {
      this.joyZone.innerHTML = "";
      this.joyZone.classList.add("is-active");
      this.manager = nipplejs.create({
        zone: this.joyZone,
        mode: "static",
        position: { left: "50%", top: "50%" },
        size: 130,
        threshold: 0.1,
        color: "white",
        restOpacity: 0.65,
      });

      this.manager?.on("move", this.updateJoyFromManager);
      this.manager?.on("start", this.updateJoyFromManager);
      this.manager?.on("end", () => {
        this.joy.x = 0;
        this.joy.y = 0;
      });

      this.joyZone.addEventListener("pointerdown", this.onPointerDown);
      this.joyZone.addEventListener("pointermove", this.onPointerMove);
      this.joyZone.addEventListener("pointerup", this.onPointerEnd);
      this.joyZone.addEventListener("pointercancel", this.onPointerEnd);
      this.joyZone.addEventListener("touchstart", this.onTouchStart, { passive: false });
      this.joyZone.addEventListener("touchmove", this.onTouchMove, { passive: false });
      this.joyZone.addEventListener("touchend", this.onTouchEnd, { passive: false });
      this.joyZone.addEventListener("touchcancel", this.onTouchEnd, { passive: false });
    }
  }

  getInput() {
    const keyboardX = (this.keys.has("ArrowRight") || this.keys.has("d") ? 1 : 0)
      - (this.keys.has("ArrowLeft") || this.keys.has("a") ? 1 : 0);
    const keyboardY = (this.keys.has("ArrowDown") || this.keys.has("s") ? 1 : 0)
      - (this.keys.has("ArrowUp") || this.keys.has("w") ? 1 : 0);
    let x = keyboardX + this.joy.x;
    let y = keyboardY + (-this.joy.y);

    const lengthSq = x * x + y * y;
    if (lengthSq > 1) {
      const length = Math.sqrt(lengthSq);
      x /= length;
      y /= length;
    }

    return { x, y };
  }

  setVisible(visible: boolean) {
    if (!this.joyZone) return;
    this.joyZone.style.display = visible ? "block" : "none";
    if (!visible) {
      this.joy.x = 0;
      this.joy.y = 0;
    }
  }

  dispose() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.joyZone?.removeEventListener("pointerdown", this.onPointerDown);
    this.joyZone?.removeEventListener("pointermove", this.onPointerMove);
    this.joyZone?.removeEventListener("pointerup", this.onPointerEnd);
    this.joyZone?.removeEventListener("pointercancel", this.onPointerEnd);
    this.joyZone?.removeEventListener("touchstart", this.onTouchStart);
    this.joyZone?.removeEventListener("touchmove", this.onTouchMove);
    this.joyZone?.removeEventListener("touchend", this.onTouchEnd);
    this.joyZone?.removeEventListener("touchcancel", this.onTouchEnd);
    this.manager?.destroy();
    this.joyZone?.classList.remove("is-active");
  }

  private updateJoyFromPoint(clientX: number, clientY: number) {
    if (!this.joyZone) return;

    const rect = this.joyZone.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const radiusX = rect.width / 2;
    const radiusY = rect.height / 2;
    const dx = radiusX > 0 ? (clientX - centerX) / radiusX : 0;
    const dy = radiusY > 0 ? (centerY - clientY) / radiusY : 0;
    const length = Math.hypot(dx, dy);

    if (length > 1) {
      this.joy.x = dx / length;
      this.joy.y = dy / length;
      return;
    }

    this.joy.x = dx;
    this.joy.y = dy;
  }

  private updateJoyFromManager = (_: unknown, data: any) => {
    if (!data) return;

    const vectorX = data?.vector?.x;
    const vectorY = data?.vector?.y;
    if (typeof vectorX === "number" && typeof vectorY === "number") {
      this.joy.x = Math.max(-1, Math.min(1, vectorX));
      this.joy.y = Math.max(-1, Math.min(1, vectorY));
      return;
    }

    const angle = data?.angle?.radian;
    const force = typeof data?.force === "number" ? data.force : 0;
    if (typeof angle === "number") {
      const scale = Math.max(0, Math.min(1, force));
      this.joy.x = Math.cos(angle) * scale;
      this.joy.y = Math.sin(angle) * scale;
    }
  };
}
