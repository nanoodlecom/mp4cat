#!/usr/bin/env node
// mp4cat CLI — lossless mp4 concatenation, no re-encode.
// Usage: mp4cat a.mp4 b.mp4 [more...] -o out.mp4

import { readFile, writeFile } from "node:fs/promises";
import { isMp4, mp4ParamsMatch, concatMp4 } from "../src/index.mjs";

const USAGE = `Usage: mp4cat <a.mp4> <b.mp4> [more.mp4 ...] -o <out.mp4>

Losslessly concatenates mp4 files by copying their compressed samples onto
one timeline — no decode, no re-encode, exact durations.

Options:
  -o, --output <file>   output path (required)
  -h, --help            show this help

Inputs must be mp4 files with matching codec parameters (same codec config,
resolution, and audio rate/channels). mp4cat errors rather than silently
re-encoding.`;

function fail(msg){
  process.stderr.write("mp4cat: " + msg + "\n");
  process.exit(1);
}

const argv = process.argv.slice(2);
if(argv.length === 0 || argv.includes("-h") || argv.includes("--help")){
  console.log(USAGE);
  process.exit(argv.length === 0 ? 1 : 0);
}

let out = null;
const inputs = [];
for(let i=0; i<argv.length; i++){
  const a = argv[i];
  if(a === "-o" || a === "--output"){
    out = argv[++i];
    if(out == null) fail("missing value for " + a);
  }else if(a.startsWith("-")){
    fail("unknown option " + a + " (see mp4cat --help)");
  }else{
    inputs.push(a);
  }
}

if(!out) fail("no output file — pass -o out.mp4");
if(inputs.length < 2) fail("need at least two input files to concatenate");

const bufs = [];
for(const file of inputs){
  let bytes;
  try{ bytes = new Uint8Array(await readFile(file)); }
  catch(e){ fail("cannot read " + file + ": " + (e && e.message || e)); }
  if(!isMp4(bytes)) fail(file + " is not an mp4 file (no ftyp box). mp4cat only concatenates mp4 — convert other containers first, e.g.:\n  ffmpeg -i input.webm -c:v libx264 -c:a aac input.mp4");
  bufs.push(bytes);
}

if(!mp4ParamsMatch(bufs)){
  fail(`input files have mismatched codec parameters, so a lossless concat would produce a broken file.
All inputs must share the same video codec config (SPS/PPS), resolution, and audio sample rate/channels,
and each must have exactly one video track (audio all-or-none).
Fix: re-encode the inputs to matching parameters first, e.g.:
  ffmpeg -i in.mp4 -vf scale=1280:720 -c:v libx264 -pix_fmt yuv420p -c:a aac -ar 44100 -ac 2 matched.mp4
then run mp4cat on the re-encoded files.`);
}

let result;
try{ result = concatMp4(bufs); }
catch(e){ fail("concat failed: " + (e && e.message || e)); }

try{ await writeFile(out, result); }
catch(e){ fail("cannot write " + out + ": " + (e && e.message || e)); }

console.log("wrote " + out + " (" + result.length + " bytes, " + inputs.length + " clips)");
