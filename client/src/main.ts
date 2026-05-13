import "./style.css";
import { Engine, WebGPUEngine } from "@babylonjs/core";
import { App } from "./app/app";

const WEBGPU_FALLBACK_KEY = "kiwi:webgpu-disabled";

function shouldUseWebGPU() {
  // Keep WebGPU disabled for the current tab after a device-loss or init failure.
  return sessionStorage.getItem(WEBGPU_FALLBACK_KEY) !== "1";
}

function restartWithWebGL(reason: string) {
  // Stop retry loops by pinning the current tab to WebGL before reloading.
  if (sessionStorage.getItem(WEBGPU_FALLBACK_KEY) === "1") return;

  console.warn(`Falling back to WebGL: ${reason}`);
  sessionStorage.setItem(WEBGPU_FALLBACK_KEY, "1");
  window.location.reload();
}

function watchWebGPUDeviceLoss(engine: WebGPUEngine) {
  // Babylon 9 restores some WebGPU state internally, but this app still trips stale bind groups after loss.
  const internalDevice = (engine as WebGPUEngine & { _device?: GPUDevice })._device;
  void internalDevice?.lost.then((info) => {
    restartWithWebGL(info.message || info.reason || "WebGPU device lost");
  });
}

function createWebGLEngine(canvas: HTMLCanvasElement) {
  // Centralize the non-WebGPU engine config so all fallback paths behave the same way.
  return new Engine(canvas, true, {
    preserveDrawingBuffer: false,
    stencil: true,
    antialias: true,
  });
}

async function createEngine(canvas: HTMLCanvasElement) {
  // Prefer WebGPU until the current tab has already seen a fatal WebGPU failure.
  if (shouldUseWebGPU() && (await WebGPUEngine.IsSupportedAsync)) {
    try {
      const webgpuEngine = new WebGPUEngine(canvas, {
        stencil: true,
        antialias: true,
      });
      await webgpuEngine.initAsync();
      watchWebGPUDeviceLoss(webgpuEngine);
      return webgpuEngine;
    } catch (error) {
      console.error("Failed to initialize WebGPU engine:", error);
      sessionStorage.setItem(WEBGPU_FALLBACK_KEY, "1");
      return createWebGLEngine(canvas);
    }
  }

  // Fall back to Babylon's WebGL engine when WebGPU is unavailable or disabled.
  return createWebGLEngine(canvas);
}

async function bootstrap() {
  const canvas = document.getElementById(
    "renderCanvas",
  ) as HTMLCanvasElement | null;

  if (!canvas) throw new Error("Missing required canvas or joystick container");

  const engine = await createEngine(canvas);

  // Route the projector directly into server view when the URL asks for it.
  const initialRoute = window.location.pathname.replace(/\/+$/, "") === "/server-view" ? "serverView" : "menu";
  const app = new App(engine, canvas, initialRoute);
  await app.start();

  engine.runRenderLoop(() => {
    app.tick();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}

await bootstrap();
