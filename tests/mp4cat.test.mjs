// mp4cat tests. Fixtures are generated at test time with ffmpeg; if ffmpeg or
// ffprobe is not installed, the fixture-dependent tests are skipped with a message.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isMp4, mp4ParamsMatch, mp4Compat, concatMp4, parseMp4, mp4Info } from "../src/index.mjs";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mp4cat.mjs");

let dir = null;                 // fixture dir, null => no ffmpeg
let a, b, other, frag, m4a1, m4a2;   // fixture paths: a+b match, other has a different resolution
let A, B, OTHER, FRAG, M4A1, M4A2;   // fixture bytes (Uint8Array)
let skipMsg = "";

async function haveTool(name){
  try{ await run(name, ["-version"]); return true; }
  catch{ return false; }
}

async function makeFixture(path, { size = "320x240", freq = 440, movflags = "+faststart" } = {}){
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=duration=1:size=${size}:rate=30`,
    "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=1`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", movflags,
    "-shortest",
    path,
  ]);
}

async function makeAudioFixture(path, { freq = 440 } = {}){
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=1`,
    "-c:a", "aac",
    "-movflags", "+faststart",
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

// walk the top-level box types of an mp4 buffer (test-side, minimal)
function topBoxes(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = []; let p = 0;
  while(p + 8 <= u8.length){
    let size = dv.getUint32(p);
    if(size === 1) size = Number(dv.getBigUint64(p+8));
    else if(size === 0) size = u8.length - p;
    out.push(String.fromCharCode(dv.getUint8(p+4), dv.getUint8(p+5), dv.getUint8(p+6), dv.getUint8(p+7)));
    if(size < 8) break;
    p += size;
  }
  return out;
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
  frag = join(dir, "frag.mp4");
  m4a1 = join(dir, "one.m4a");
  m4a2 = join(dir, "two.m4a");
  await makeFixture(a);
  await makeFixture(b, { freq: 660 });
  await makeFixture(other, { size: "640x480" });
  await makeFixture(frag, { freq: 550, movflags: "frag_keyframe+empty_moov+default_base_moof" });
  await makeAudioFixture(m4a1);
  await makeAudioFixture(m4a2, { freq: 660 });
  [A, B, OTHER, FRAG, M4A1, M4A2] = await Promise.all(
    [a, b, other, frag, m4a1, m4a2].map(async p => new Uint8Array(await readFile(p)))
  );
});

test("isMp4 rejects garbage bytes (no ffmpeg needed)", () => {
  assert.equal(isMp4(new Uint8Array(0)), false);
  assert.equal(isMp4(new Uint8Array([1,2,3])), false);
  assert.equal(isMp4(new TextEncoder().encode("this is definitely not an mp4 file at all")), false);
});

test("mp4Compat rejects short input with a reason (no ffmpeg needed)", () => {
  assert.equal(mp4Compat([]).ok, false);
  assert.match(mp4Compat([new Uint8Array(4)]).reason, /at least two clips/);
  const r = mp4Compat([new Uint8Array(4), new Uint8Array(4)], { names: ["x.mp4", "y.mp4"] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /x\.mp4 is not a parseable mp4/);
});

test("isMp4 accepts real mp4 fixtures", (t) => {
  if(!dir) return t.skip(skipMsg);
  for(const f of [A, B, OTHER, FRAG, M4A1]) assert.equal(isMp4(f), true);
});

test("parseMp4 finds one video and one audio track", (t) => {
  if(!dir) return t.skip(skipMsg);
  const p = parseMp4(A);
  assert.equal(p.fragmented, false);
  assert.equal(p.tracks.filter(x => x.kind === "video").length, 1);
  assert.equal(p.tracks.filter(x => x.kind === "audio").length, 1);
  const v = p.tracks.find(x => x.kind === "video");
  assert.equal(v.width, 320);
  assert.equal(v.height, 240);
  assert.equal(v.sampleEntry, "avc1");
});

test("parseMp4 reads fragmented mp4 (moof/trun) samples", (t) => {
  if(!dir) return t.skip(skipMsg);
  const p = parseMp4(FRAG);
  assert.equal(p.fragmented, true);
  const v = p.tracks.find(x => x.kind === "video");
  const au = p.tracks.find(x => x.kind === "audio");
  assert.ok(v.samples.length >= 25, `expected ~30 video samples, got ${v.samples.length}`);
  assert.ok(au.samples.length >= 20, `expected ~43 audio samples, got ${au.samples.length}`);
  assert.ok(v.samples.some(s => s.sync), "at least one video sync sample");
  // fragment sample offsets must point at real mdat bytes, not past EOF
  for(const s of [...v.samples, ...au.samples]) assert.ok(s.offset + s.size <= FRAG.length, "sample within file");
});

test("mp4ParamsMatch: true for the matching pair, false for mismatched resolution", (t) => {
  if(!dir) return t.skip(skipMsg);
  assert.equal(mp4ParamsMatch([A, B]), true);
  assert.equal(mp4ParamsMatch([A, OTHER]), false);
  assert.equal(mp4ParamsMatch([A]), false, "single input is not a concat");
});

test("mp4Compat explains a resolution mismatch, naming the file", (t) => {
  if(!dir) return t.skip(skipMsg);
  const r = mp4Compat([A, OTHER], { names: ["a.mp4", "other.mp4"] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /other\.mp4 is 640x480 but a\.mp4 is 320x240/);
  assert.equal(mp4Compat([A, B]).reason, null);
});

test("mp4Info reports duration, codec, dimensions, and rates", (t) => {
  if(!dir) return t.skip(skipMsg);
  const i = mp4Info(A);
  assert.ok(Math.abs(i.duration - 1) < 0.15, `duration ${i.duration} ≈ 1s`);
  const v = i.tracks.find(x => x.kind === "video");
  const au = i.tracks.find(x => x.kind === "audio");
  assert.equal(v.codec, "avc1");
  assert.equal(v.codecName, "h264");
  assert.equal(v.width, 320);
  assert.equal(v.height, 240);
  assert.ok(Math.abs(v.fps - 30) < 1, `fps ${v.fps} ≈ 30`);
  assert.equal(au.codecName, "aac");
  assert.equal(au.sampleRate, 44100);
  assert.ok(au.channels >= 1);
  assert.equal(mp4Info(FRAG).fragmented, true);
});

test("concatMp4 output: correct duration, streams, and fully decodable", async (t) => {
  if(!dir) return t.skip(skipMsg);
  const out = join(dir, "out.mp4");
  const bytes = concatMp4([A, B]);
  assert.equal(isMp4(bytes), true, "output should itself be an mp4");
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

test("concatMp4 output is streamable: moov before mdat, tracks interleaved", (t) => {
  if(!dir) return t.skip(skipMsg);
  const bytes = concatMp4([A, B]);
  const boxes = topBoxes(bytes);
  assert.ok(boxes.indexOf("moov") < boxes.indexOf("mdat"),
    `moov must precede mdat for progressive playback, got ${boxes.join(",")}`);
  // interleaved: the video samples must not all sit before all audio samples (or vice versa)
  const p = parseMp4(bytes);
  const v = p.tracks.find(x => x.kind === "video").samples;
  const au = p.tracks.find(x => x.kind === "audio").samples;
  const vMax = Math.max(...v.map(s => s.offset)), aMin = Math.min(...au.map(s => s.offset));
  const aMax = Math.max(...au.map(s => s.offset)), vMin = Math.min(...v.map(s => s.offset));
  assert.ok(vMax > aMin && aMax > vMin, "video and audio byte ranges should overlap (interleaved)");
});

test("concatMp4 accepts fragmented input mixed with progressive", async (t) => {
  if(!dir) return t.skip(skipMsg);
  const r = mp4Compat([A, FRAG], { names: ["a.mp4", "frag.mp4"] });
  assert.equal(r.ok, true, `gate should pass for same-encoder frag+progressive: ${r.reason}`);
  const out = join(dir, "frag-out.mp4");
  await writeFile(out, concatMp4([A, FRAG]));
  const po = await probeFormat(out);
  assert.ok(Math.abs(Number(po.format.duration) - 2) <= 0.2, `duration ${po.format.duration} ≈ 2s`);
  const { stderr } = await run("ffmpeg", ["-v", "error", "-i", out, "-f", "null", "-"]);
  assert.equal(stderr.trim(), "", "ffmpeg full decode should report no errors");
});

test("audio-only concat (m4a): gate passes, output decodes, duration adds up", async (t) => {
  if(!dir) return t.skip(skipMsg);
  const r = mp4Compat([M4A1, M4A2]);
  assert.equal(r.ok, true, `audio-only pair should be compatible: ${r.reason}`);
  const out = join(dir, "audio-out.m4a");
  await writeFile(out, concatMp4([M4A1, M4A2]));
  const po = await probeFormat(out);
  assert.equal(po.streams.filter(s => s.codec_type === "video").length, 0);
  assert.equal(po.streams.filter(s => s.codec_type === "audio").length, 1);
  assert.ok(Math.abs(Number(po.format.duration) - 2) <= 0.2, `duration ${po.format.duration} ≈ 2s`);
  const { stderr } = await run("ffmpeg", ["-v", "error", "-i", out, "-f", "null", "-"]);
  assert.equal(stderr.trim(), "", "ffmpeg full decode should report no errors");
  // audio + video must not gate together
  assert.equal(mp4Compat([M4A1, A]).ok, false);
});

test("CLI end-to-end: concat two files, refuse mismatched ones", async (t) => {
  if(!dir) return t.skip(skipMsg);
  const out = join(dir, "cli-out.mp4");
  const { stdout } = await run(process.execPath, [CLI, a, b, "-o", out]);
  assert.match(stdout, /wrote .*cli-out\.mp4/);
  const po = await probeFormat(out);
  assert.ok(Number(po.format.duration) > 1.5, "CLI output covers both clips");

  // mismatched inputs must exit non-zero with actionable advice naming the file
  await assert.rejects(
    run(process.execPath, [CLI, a, other, "-o", join(dir, "nope.mp4")]),
    (e) => {
      assert.equal(e.code, 1);
      assert.match(e.stderr, /mismatched codec parameters/);
      assert.match(e.stderr, /other\.mp4 is 640x480/);
      assert.match(e.stderr, /re-encode/i);
      return true;
    }
  );

  // garbage input must be rejected as not-mp4
  const junk = join(dir, "junk.mp4");
  await writeFile(junk, "not a movie");
  await assert.rejects(
    run(process.execPath, [CLI, a, junk, "-o", join(dir, "nope2.mp4")]),
    (e) => { assert.match(e.stderr, /not an mp4 file/); return true; }
  );
});

test("CLI --info: human and JSON output", async (t) => {
  if(!dir) return t.skip(skipMsg);
  const { stdout } = await run(process.execPath, [CLI, "--info", a]);
  assert.match(stdout, /duration\s+1\.\d\ds/);
  assert.match(stdout, /video\s+avc1 \(h264\) 320x240/);
  assert.match(stdout, /audio\s+mp4a \(aac\) 44100 Hz/);

  const { stdout: js } = await run(process.execPath, [CLI, "--info", "--json", a, frag]);
  const parsed = JSON.parse(js);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].tracks.find(x => x.kind === "video").codecName, "h264");
  assert.equal(parsed[1].fragmented, true);
});

test("CLI: -o - writes the mp4 to stdout, --dedup drops one frame per seam, --version prints semver", async (t) => {
  if(!dir) return t.skip(skipMsg);
  const { stdout } = await run(process.execPath, [CLI, a, b, "-o", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(isMp4(new Uint8Array(stdout)), true, "stdout should carry a valid mp4");

  const plain = concatMp4([A, B]);
  const { stdout: dd } = await run(process.execPath, [CLI, a, b, "--dedup", "-o", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const nv = (u8) => parseMp4(new Uint8Array(u8)).tracks.find(x => x.kind === "video").samples.length;
  assert.equal(nv(dd), nv(plain) - 1, "--dedup drops exactly the second clip's first video sample");

  const { stdout: ver } = await run(process.execPath, [CLI, "--version"]);
  assert.match(ver.trim(), /^\d+\.\d+\.\d+$/);
});

test("cleanup", async (t) => {
  if(dir) await rm(dir, { recursive: true, force: true });
});
