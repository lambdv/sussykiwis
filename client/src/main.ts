import "./style.css";
import { App } from "./app/app";

async function bootstrap() {
  const root = document.getElementById("appRoot") as HTMLDivElement | null;

  if (!root) throw new Error("Missing required app root");

  const initialRoute = window.location.pathname.replace(/\/+$/, "") === "/server-view" ? "serverView" : "menu";
  new App(root, initialRoute);
}

await bootstrap();
