import "./style.css";
import { App } from "./app/app";
import { resolveBootstrapRoute } from "./app/bootstrapRoute";

async function bootstrap() {
  const root = document.getElementById("appRoot") as HTMLDivElement | null;

  if (!root) throw new Error("Missing required app root");

  const initialRoute = resolveBootstrapRoute(window.location.pathname);
  new App(root, initialRoute);
}

await bootstrap();
