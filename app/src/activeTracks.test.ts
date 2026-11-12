import { expect, test } from "vitest";
import { activeTrackIds } from "./activeTracks";

const idle = { replaying: false, hoverId: null, groupIds: null, selectedId: null };

test("replay suspends every highlight", () => {
  expect(
    activeTrackIds({ replaying: true, hoverId: "h", groupIds: ["a", "b"], selectedId: "s" }),
  ).toEqual([]);
  expect(activeTrackIds({ ...idle, replaying: true })).toEqual([]);
});

test("hover beats the group, the group beats the selection", () => {
  const all = { ...idle, hoverId: "h", groupIds: ["a", "b"], selectedId: "a" };
  expect(activeTrackIds(all)).toEqual(["h"]);
  expect(activeTrackIds({ ...all, hoverId: null })).toEqual(["a", "b"]);
  expect(activeTrackIds({ ...all, hoverId: null, groupIds: null })).toEqual(["a"]);
  expect(activeTrackIds(idle)).toEqual([]);
});

test("an empty group falls back to the selection", () => {
  expect(activeTrackIds({ ...idle, groupIds: [], selectedId: "s" })).toEqual(["s"]);
  expect(activeTrackIds({ ...idle, groupIds: [] })).toEqual([]);
});
