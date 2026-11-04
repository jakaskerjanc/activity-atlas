import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeChannel, ENCODING_VERSION, type StreamChannel } from "./codec.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codec.json");

interface Case {
  name: string;
  channel: StreamChannel;
  values: (number | null)[];
  blob: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { encoding: number; cases: Case[] };

test("decodes every python fixture", () => {
  assert.ok(fixture.cases.length >= 10);
  for (const c of fixture.cases) {
    assert.deepEqual(decodeChannel(c.channel, Buffer.from(c.blob, "base64")), c.values, c.name);
  }
});

test("fixture encoding matches ENCODING_VERSION", () => {
  assert.equal(fixture.encoding, ENCODING_VERSION);
});

test("rejects an unknown channel", () => {
  const blob = Buffer.from(fixture.cases[0].blob, "base64");
  assert.throws(() => decodeChannel("foo" as StreamChannel, blob));
});

test("the test encoder round-trips every fixture case", async () => {
  const { encodeChannel } = await import("./testDb.ts");
  for (const c of fixture.cases) {
    assert.deepEqual(decodeChannel(c.channel, encodeChannel(c.channel, c.values)), c.values, c.name);
  }
});
