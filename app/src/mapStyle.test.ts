import { describe, expect, test } from "vitest";
import { staticMapUrl } from "./mapStyle";

describe("staticMapUrl", () => {
  test("asks the Static Images API for the style at exactly the camera, at 2x", () => {
    const url = staticMapUrl("mapbox://styles/mapbox/dark-v11", { center: [14.5, 46.05], zoom: 12.3456 }, 320, 200, "pk.a/b");
    expect(url).toBe(
      "https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/14.500000,46.050000,12.35/320x200@2x?logo=false&attribution=false&access_token=pk.a%2Fb",
    );
  });

  test("works for a user's own style", () => {
    expect(staticMapUrl("mapbox://styles/someone/abc123", { center: [0, 0], zoom: 1 }, 10, 10, "t")).toContain(
      "/styles/v1/someone/abc123/static/",
    );
  });
});
