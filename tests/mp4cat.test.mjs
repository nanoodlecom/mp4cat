// mp4cat tests. Fixtures are generated at test time with ffmpeg; if ffmpeg or
// ffprobe is not installed, the fixture-dependent tests are skipped with a message.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isMp4, mp4ParamsMatch, concatMp4, parseMp4 } from "../src/index.mjs";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mp4cat.mjs");

let dir = null;          // fixture dir, null => no ffmpeg
let a, b, other;         // fixture paths: a+b match, other has a different resolution
let A, B, OTHER;         // fixture bytes (Uint8Array)
let skipMsg = "";

async function haveTool(name){
  try{ await run(name, ["-version"]); return true; }
  catch{ return false; }
}

async function makeFixture(path, { size = "320x240", freq = 440 } = {}){
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=duration=1:size=${size}:rate=30`,
    "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=1`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "+faststart",
    "-shortest",
    path,
  ]);
}

async function probeFormat(path){
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", path,
  ]);
  return JSON.parse(stdout);
}

before(async () => {
  if(!(await haveTool("ffmpeg")) || !(await haveTool("ffprobe"))){
    skipMsg = "ffmpeg/ffprobe not found on PATH — skipping fixture-based tests";
    console.log(skipMsg);
    return;
  }
  dir = await mkdtemp(join(tmpdir(), "mp4cat-test-"));
  a = join(dir, "a.mp4");
  b = join(dir, "b.mp4");
  other = join(dir, "other.mp4");
  await makeFixture(a);
  await makeFixture(b, { freq: 660 });
  await makeFixture(other, { size: "640x480" });
  [A, B, OTHER] = await Promise.all([a, b, other].map(async p => new Uint8Array(await readFile(p))));
});

test("isMp4 rejects garbage bytes (no ffmpeg needed)", () => {
  assert.equal(isMp4(new Uint8Array(0)), false);
  assert.equal(isMp4(new Uint8Array([1,2,3])), false);
  assert.equal(isMp4(new TextEncoder().encode("this is definitely not an mp4 file at all")), false);
});

test("isMp4 accepts real mp4 fixtures", (t) => {
  if(!dir) return t.skip(skipMsg);
  assert.equal(isMp4(A), true);
  assert.equal(isMp4(B), true);
  assert.equal(isMp4(OTHER), true);
});

test("parseMp4 finds one video and one audio track", (t) => {
  if(!dir) return t.skip(skipMsg);
  const p = parseMp4(A);
  assert.equal(p.tracks.filter(x => x.kind === "video").length, 1);
  assert.equal(p.tracks.filter(x => x.kind === "audio").length, 1);
  const v = p.tracks.find(x => x.kind === "video");
  assert.equal(v.width, 320);
  assert.equal(v.height, 240);
});

test("mp4ParamsMatch: true for the matching pair, false for mismatched resolution", (t) => {
  if(!dir) return t.skip(skipMsg);
  assert.equal(mp4ParamsMatch([A, B]), true);
  assert.equal(mp4ParamsMatch([A, OTHER]), false);
  assert.equal(mp4ParamsMatch([A]), false, "single input is not a concat");
});

test("concatMp4 output: correct duration, streams, and fully decodable", async (t) => {
  if(!dir) return t.skip(skipMsg);
  const out = join(dir, "out.mp4");
  const bytes = concatMp4([A, B]);
  assert.equal(isMp4(bytes), true, "output should itself be an mp4");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(out, bytes);

  const [pa, pb, po] = await Promise.all([probeFormat(a), probeFormat(b), probeFormat(out)]);
  const expected = Number(pa.format.duration) + Number(pb.format.duration);
  const got = Number(po.format.duration);
  assert.ok(Math.abs(got - expected) <= 0.15,
    `duration ${got}s should be within 0.15s of ${expected}s`);

  const vids = po.streams.filter(s => s.codec_type === "video");
  const auds = po.streams.filter(s => s.codec_type === "audio");
  assert.equal(vids.length, 1, "one video stream");
  assert.equal(auds.length, 1, "one audio stream");
  assert.equal(vids[0].width, 320);
  assert.equal(vids[0].height, 240);

  // full decode must be error-free
  const { stderr } = await run("ffmpeg", ["-v", "error", "-i", out, "-f", "null", "-"]);
  assert.equal(stderr.trim(), "", "ffmpeg full decode should report no errors");
});

test("CLI end-to-end: concat two files, refuse mismatched ones", async (t) => {
  if(!dir) return t.skip(skipMsg);
  const out = join(dir, "cli-out.mp4");
  const { stdout } = await run(process.execPath, [CLI, a, b, "-o", out]);
  assert.match(stdout, /wrote .*cli-out\.mp4/);
  const po = await probeFormat(out);
  assert.ok(Number(po.format.duration) > 1.5, "CLI output covers both clips");

  // mismatched inputs must exit non-zero with actionable advice
  await assert.rejects(
    run(process.execPath, [CLI, a, other, "-o", join(dir, "nope.mp4")]),
    (e) => {
      assert.equal(e.code, 1);
      assert.match(e.stderr, /mismatched codec parameters/);
      assert.match(e.stderr, /re-encode/i);
      return true;
    }
  );

  // garbage input must be rejected as not-mp4
  const { writeFile } = await import("node:fs/promises");
  const junk = join(dir, "junk.mp4");
  await writeFile(junk, "not a movie");
  await assert.rejects(
    run(process.execPath, [CLI, a, junk, "-o", join(dir, "nope2.mp4")]),
    (e) => { assert.match(e.stderr, /not an mp4 file/); return true; }
  );
});

test("cleanup", async (t) => {
  if(dir) await rm(dir, { recursive: true, force: true });
});
