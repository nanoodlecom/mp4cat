#!/usr/bin/env node
// mp4cat CLI — lossless mp4 concatenation, no re-encode.
// Usage: mp4cat a.mp4 b.mp4 [more...] -o out.mp4
//        mp4cat --info a.mp4 [b.mp4 ...]

import { readFile, writeFile } from "node:fs/promises";
import { isMp4, mp4Compat, concatMp4, mp4Info } from "../src/index.mjs";

const USAGE = `Usage: mp4cat <a.mp4> <b.mp4> [more.mp4 ...] -o <out.mp4>
       mp4cat --info <file.mp4> [more.mp4 ...]

Losslessly concatenates mp4 files by copying their compressed samples onto
one timeline — no decode, no re-encode, exact durations. Output is
streamable (moov first, tracks interleaved). Fragmented mp4 (fMP4/CMAF)
inputs are read; output is always progressive mp4.

Options:
  -o, --output <file>   output path ("-" writes the mp4 to stdout)
  -i, --info            print duration/codec/resolution info per file, no concat
      --json            with --info: print machine-readable JSON
      --dedup           drop each later clip's first video frame (for chained
                        continuations where clip N+1 starts on clip N's last frame)
  -V, --version         print version
  -h, --help            show this help

Inputs must be mp4 files with matching codec parameters (same codec config,
resolution, and audio rate/channels; video and audio each all-or-none).
mp4cat errors rather than silently re-encoding.`;

function fail(msg){
  process.stderr.write("mp4cat: " + msg + "\n");
  process.exit(1);
}

// a downstream pipe closing early (mp4cat ... -o - | head) is normal Unix behavior, not a crash
process.stdout.on("error", (e) => { if(e.code === "EPIPE") process.exit(0); throw e; });

const argv = process.argv.slice(2);
if(argv.length === 0 || argv.includes("-h") || argv.includes("--help")){
  console.log(USAGE);
  process.exit(argv.length === 0 ? 1 : 0);
}
if(argv.includes("-V") || argv.includes("--version")){
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

let out = null, info = false, json = false, dedup = false;
const inputs = [];
for(let i=0; i<argv.length; i++){
  const a = argv[i];
  if(a === "-o" || a === "--output"){
    out = argv[++i];
    if(out == null) fail("missing value for " + a);
  }else if(a === "-i" || a === "--info"){
    info = true;
  }else if(a === "--json"){
    json = true;
  }else if(a === "--dedup"){
    dedup = true;
  }else if(a === "-"){
    fail("stdin input is not supported — pass file paths"); // -o's value is consumed above, so this is always a bare input
  }else if(a.startsWith("-")){
    fail("unknown option " + a + " (see mp4cat --help)");
  }else{
    inputs.push(a);
  }
}

// every accepted flag must affect the run — silently ignoring a flag hides user mistakes
if(info && (out !== null || dedup)) fail("--info inspects files and cannot be combined with " + (dedup ? "--dedup" : "-o"));
if(!info && json) fail("--json requires --info");

async function readMp4(file){
  let bytes;
  try{ bytes = new Uint8Array(await readFile(file)); }
  catch(e){ fail("cannot read " + file + ": " + (e && e.message || e)); }
  if(!isMp4(bytes)) fail(file + " is not an mp4 file (no ftyp box). mp4cat only concatenates mp4 — convert other containers first, e.g.:\n  ffmpeg -i input.webm -c:v libx264 -c:a aac input.mp4");
  return bytes;
}

if(info){
  // no process.exit here: exiting before async stdout drains truncates piped output
  if(!inputs.length) fail("--info needs at least one file");
  const all = [];
  for(const file of inputs){
    const bytes = await readMp4(file);
    let probe;
    try{ probe = mp4Info(bytes); }
    catch(e){ fail("cannot parse " + file + ": " + (e && e.message || e)); }
    all.push({ file, bytes: bytes.length, ...probe });
  }
  if(json){
    console.log(JSON.stringify(all, null, 2));
  }else{
    for(const f of all){
      console.log(f.file);
      console.log("  duration   " + f.duration.toFixed(2) + "s (" + (f.fragmented ? "fragmented" : "progressive") + " mp4, " + f.bytes + " bytes)");
      for(const t of f.tracks){
        if(t.kind === "video") console.log("  video      " + t.codec + " (" + t.codecName + ") " + t.width + "x" + t.height + " @ " + t.fps + " fps, " + t.sampleCount + " samples");
        else console.log("  audio      " + t.codec + " (" + t.codecName + ") " + t.sampleRate + " Hz, " + t.channels + " ch, " + t.sampleCount + " samples");
      }
    }
  }
}else{
  if(!out) fail("no output file — pass -o out.mp4 (or -o - for stdout), or --info to inspect files");
  if(inputs.length < 2) fail("need at least two input files to concatenate");

  const bufs = [];
  for(const file of inputs) bufs.push(await readMp4(file));

  const compat = mp4Compat(bufs, { names: inputs });
  if(!compat.ok){
    fail(`input files have mismatched codec parameters, so a lossless concat would produce a broken file.
Problem: ${compat.reason}.
Fix: re-encode the inputs to matching parameters first, e.g.:
  ffmpeg -i in.mp4 -vf scale=1280:720 -c:v libx264 -pix_fmt yuv420p -c:a aac -ar 44100 -ac 2 matched.mp4
then run mp4cat on the re-encoded files.`);
  }

  let result;
  try{ result = concatMp4(bufs, { dedup }); }
  catch(e){ fail("concat failed: " + (e && e.message || e)); }

  if(out === "-"){
    process.stdout.write(result);
    process.stderr.write("mp4cat: wrote mp4 to stdout (" + result.length + " bytes, " + inputs.length + " clips)\n");
  }else{
    try{ await writeFile(out, result); }
    catch(e){ fail("cannot write " + out + ": " + (e && e.message || e)); }
    console.log("wrote " + out + " (" + result.length + " bytes, " + inputs.length + " clips)");
  }
}
