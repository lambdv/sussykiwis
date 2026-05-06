import "./style.css";
import { Engine, WebGPUEngine } from "@babylonjs/core";
import { App } from "./app/app";

async function bootstrap() {
  const canvas = document.getElementById(
    "renderCanvas",
  ) as HTMLCanvasElement | null;

  if (!canvas) throw new Error("Missing required canvas or joystick container");

  let engine: Engine | WebGPUEngine;

  // either web gpu or default engine
  if (await WebGPUEngine.IsSupportedAsync) {
    const webgpuEngine = new WebGPUEngine(canvas, {
      stencil: true,
      antialias: true,
    });
    await webgpuEngine.initAsync();
    engine = webgpuEngine;
  } else {
    engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: true,
      antialias: true,
    });
  }

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
