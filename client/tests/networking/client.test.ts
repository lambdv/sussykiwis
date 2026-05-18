import { describe, expect, test } from "bun:test";

import { NetworkClient } from "../../src/networking/client";

describe("NetworkClient input sequencing", () => {
  test("keeps one monotonic input stream across scene reuse", () => {
    const client = new NetworkClient();

    // Scene transitions reuse the same network session, so input ids must keep rising.
    expect(client.nextInputSeq()).toBe(1);
    expect(client.nextInputSeq()).toBe(2);
    expect(client.nextInputSeq()).toBe(3);
  });

  test("resets sequencing when the websocket session is reset", () => {
    const client = new NetworkClient();

    client.nextInputSeq();
    client.nextInputSeq();
    client.disconnect();

    expect(client.nextInputSeq()).toBe(1);
  });
});
