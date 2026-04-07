import { beforeAll, describe, test, expect, it } from "bun:test";

let itIfServer = it;

beforeAll(async () => {
  let serverGuard = await checkServer();

  itIfServer = serverGuard ? it : it.skip;
});

async function checkServer(): Promise<boolean> {
  return await fetch("http://localhost:3000/health").then((res) => res.ok);
}

describe("hello world", () => {
  itIfServer(
    "should perform an action only if the server is running",
    async () => {
      const res = await fetch("http://localhost:3000/ping");
      const data = await res.json();
      expect(data.message).toEqual("pong");
      expect(res.status).toEqual(200);
    },
  );

  itIfServer("test isn't failing", async () => {
    const res = await fetch("http://localhost:3000/ping");
    const data = await res.json();
    expect(data.message).toEqual("pong");
    expect(res.status).not.toEqual(400);
  });
});
