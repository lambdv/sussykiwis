import { describe, expect, test } from "bun:test";

import { resolveBootstrapRoute } from "../../src/app/bootstrapRoute";

describe("resolveBootstrapRoute", () => {
  test("treats root as the auto-join route", () => {
    expect(resolveBootstrapRoute("/")).toBe("root");
  });

  test("maps openday and the old server-view alias", () => {
    expect(resolveBootstrapRoute("/openday")).toBe("openday");
    expect(resolveBootstrapRoute("/server-view")).toBe("openday");
  });

  test("falls back to menu for unknown paths", () => {
    expect(resolveBootstrapRoute("/something-else")).toBe("menu");
  });
});
