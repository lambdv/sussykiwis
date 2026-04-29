import { beforeAll, describe, test, expect, it } from "bun:test";

let itIfServer = it;

beforeAll(async () => {
  let serverGuard = await checkServer();

  itIfServer = serverGuard ? it : it.skip;
});

async function checkServer(): Promise<boolean> {
  // Allow overriding base URL so docker/nginx `/api` setups can be tested.
  const base = process.env.SERVER_URI ?? process.env.VITE_SERVER_URI ?? "http://localhost:3000";
  try {
    return await fetch(`${base.replace(/\/+$/, "")}/health`).then((res) => res.ok);
  } catch {
    return false;
  }
}

describe("hello world", () => {
  itIfServer(
    "should perform an action only if the server is running",
    async () => {
      const base =
        process.env.SERVER_URI ?? process.env.VITE_SERVER_URI ?? "http://localhost:3000";
      const res = await fetch(`${base.replace(/\/+$/, "")}/ping`);
      const data = await res.json();
      expect(data.message).toEqual("pong");
      expect(res.status).toEqual(200);
    },
  );

  itIfServer("test isn't failing", async () => {
    const base = process.env.SERVER_URI ?? process.env.VITE_SERVER_URI ?? "http://localhost:3000";
    const res = await fetch(`${base.replace(/\/+$/, "")}/ping`);
    const data = await res.json();
    expect(data.message).toEqual("pong");
    expect(res.status).not.toEqual(400);
  });
});
