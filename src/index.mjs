/* mp4cat — lossless mp4 concatenation.
   Copies the compressed H.264+AAC samples from each clip onto one timeline and writes a single mp4:
   no decode/re-encode, no MediaRecorder, no AudioContext. Duration is exact by construction.
   Use when every clip is mp4 with matching codec params (see mp4ParamsMatch).
   Pure DataView/Uint8Array — runs in Node and the browser as-is.

   Extracted from nanoodle's Combine node (https://github.com/nanoodlecom/nanoodle). */

const fourcc = (dv, p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p+1), dv.getUint8(p+2), dv.getUint8(p+3));

function walk(dv, start, end){
  const out = [];
  let p = start;
  while(p + 8 <= end){
    let size = dv.getUint32(p);
    const type = fourcc(dv, p+4);
    let hs = 8;
    if(size === 1){ size = Number(dv.getBigUint64(p+8)); hs = 16; }
    else if(size === 0){ size = end - p; }
    if(size < 8 || p + size > end) break;
    out.push({ type, start: p, end: p+size, body: p+hs });
    p += size;
  }
  return out;
}
const find = (boxes, type) => boxes.find(b => b.type === type);

// Scan a byte range for a box of the given 4cc and return its bytes (used to pull avcC/esds out of
// an stsd for the match gate — the surrounding sample entry can carry clip-specific boxes like btrt).
function scanForBox(u8, type){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for(let p=0; p+8<=u8.length; p++){
    if(fourcc(dv, p+4) === type){
      const size = dv.getUint32(p);
      if(size >= 8 && p + size <= u8.length) return u8.slice(p, p+size);
    }
  }
  return null;
}

// Parse one mp4 into { moovTimescale, tracks:[{kind, timescale, stsdRaw, samples:[{offset,size,dur,cts,sync}], width,height}] }
export function parseMp4(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const top = walk(dv, 0, u8.byteLength);
  const moov = find(top, "moov");
  if(!moov) throw new Error("no moov");
  const moovBoxes = walk(dv, moov.body, moov.end);
  const traks = moovBoxes.filter(b => b.type === "trak");
  const tracks = [];
  for(const trak of traks){
    const tb = walk(dv, trak.body, trak.end);
    const mdia = find(tb, "mdia"); if(!mdia) continue;
    const mb = walk(dv, mdia.body, mdia.end);
    const mdhd = find(mb, "mdhd");
    const hdlr = find(mb, "hdlr");
    const mdhdV1 = dv.getUint8(mdhd.body) === 1;
    // v0: [ver/flags 4][ctime 4][mtime 4][timescale 4]; v1: [ver/flags 4][ctime 8][mtime 8][timescale 4]
    const timescale = dv.getUint32(mdhd.body + (mdhdV1 ? 20 : 12));
    const handler = fourcc(dv, hdlr.body + 8); // after ver/flags(4)+pre_defined(4)
    const kind = handler === "vide" ? "video" : handler === "soun" ? "audio" : handler;
    const minf = find(mb, "minf"); const minfB = walk(dv, minf.body, minf.end);
    const stbl = find(minfB, "stbl"); const sb = walk(dv, stbl.body, stbl.end);
    const stsd = find(sb, "stsd");
    const stsdRaw = u8.slice(stsd.start, stsd.end); // whole stsd box, copied verbatim into output
    // codec config only (SPS/PPS or audio decoder config) — the equality signal for the match gate,
    // excluding clip-specific sample-entry boxes (btrt etc) that differ by content.
    const codecCfg = scanForBox(stsdRaw, kind==="video" ? "avcC" : "esds")
                  || scanForBox(stsdRaw, "hvcC") || scanForBox(stsdRaw, "vpcC") || scanForBox(stsdRaw, "av1C");
    // video dims from tkhd
    let width = 0, height = 0;
    const tkhd = find(tb, "tkhd");
    if(tkhd && kind === "video"){ width = dv.getUint16(tkhd.end - 8) ; height = dv.getUint16(tkhd.end - 4); }
    // audio rate/channels from the mp4a sample entry (esds carries clip-specific bitrate, so it's not
    // a stable equality signal — rate+channels is what decides concat compatibility).
    let channels = 0, sampleRate = 0;
    if(kind === "audio"){ const mp4a = scanForBox(stsdRaw, "mp4a"); if(mp4a){ const adv = new DataView(mp4a.buffer, mp4a.byteOffset, mp4a.byteLength); channels = adv.getUint16(24); sampleRate = adv.getUint16(32); } }

    // --- sample tables ---
    const stts = find(sb, "stts"), stsc = find(sb, "stsc"), stsz = find(sb, "stsz");
    const stco = find(sb, "stco"), co64 = find(sb, "co64"), ctts = find(sb, "ctts"), stss = find(sb, "stss");

    // stsz
    const stszSampleSize = dv.getUint32(stsz.body + 4);
    const sampleCount = dv.getUint32(stsz.body + 8);
    const sizes = new Array(sampleCount);
    if(stszSampleSize === 0){ for(let i=0;i<sampleCount;i++) sizes[i] = dv.getUint32(stsz.body + 12 + i*4); }
    else sizes.fill(stszSampleSize);

    // stts -> per-sample duration
    const sttsN = dv.getUint32(stts.body + 4);
    const durs = new Array(sampleCount); let si = 0;
    for(let e=0;e<sttsN;e++){ const cnt = dv.getUint32(stts.body + 8 + e*8); const delta = dv.getUint32(stts.body + 12 + e*8); for(let k=0;k<cnt && si<sampleCount;k++) durs[si++] = delta; }
    while(si < sampleCount) durs[si++] = durs[si-2] || 0;

    // ctts -> per-sample composition offset (may be signed in v1; treat as int32)
    const cts = new Array(sampleCount).fill(0);
    if(ctts){ const n = dv.getUint32(ctts.body + 4); let ci = 0; for(let e=0;e<n;e++){ const cnt = dv.getUint32(ctts.body + 8 + e*8); const off = dv.getInt32(ctts.body + 12 + e*8); for(let k=0;k<cnt && ci<sampleCount;k++) cts[ci++] = off; } }

    // stss -> sync set (1-based). absent => all sync
    let syncSet = null;
    if(stss){ syncSet = new Set(); const n = dv.getUint32(stss.body + 4); for(let e=0;e<n;e++) syncSet.add(dv.getUint32(stss.body + 8 + e*4)); }

    // chunk offsets
    const co = stco || co64; const is64 = !!co64;
    const coN = dv.getUint32(co.body + 4);
    const chunkOffsets = new Array(coN);
    for(let e=0;e<coN;e++) chunkOffsets[e] = is64 ? Number(dv.getBigUint64(co.body + 8 + e*8)) : dv.getUint32(co.body + 8 + e*4);

    // stsc -> samples per chunk
    const stscN = dv.getUint32(stsc.body + 4);
    const stscEntries = [];
    for(let e=0;e<stscN;e++) stscEntries.push({ first: dv.getUint32(stsc.body + 8 + e*12), spc: dv.getUint32(stsc.body + 12 + e*12) });

    // compute per-sample file offset
    const samples = [];
    let sIdx = 0;
    for(let c=0;c<coN;c++){
      // samples in this chunk = spc from the applicable stsc entry
      let spc = 1;
      for(let e=stscEntries.length-1;e>=0;e--){ if((c+1) >= stscEntries[e].first){ spc = stscEntries[e].spc; break; } }
      let off = chunkOffsets[c];
      for(let k=0;k<spc && sIdx<sampleCount;k++){
        samples.push({ offset: off, size: sizes[sIdx], dur: durs[sIdx], cts: cts[sIdx], sync: syncSet ? syncSet.has(sIdx+1) : true });
        off += sizes[sIdx];
        sIdx++;
      }
    }
    if(samples.length !== sampleCount) throw new Error("sample count mismatch " + samples.length + "/" + sampleCount);
    tracks.push({ kind, timescale, stsdRaw, codecCfg, samples, width, height, channels, sampleRate });
  }
  return { tracks };
}

// ---- box writers ----
const enc = (s) => Uint8Array.from(s, c => c.charCodeAt(0));
function u32(n){ const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n>>>0); return a; }
function u16(n){ const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, n & 0xffff); return a; }
function concat(arrs){ let len=0; for(const a of arrs) len += a.length; const out = new Uint8Array(len); let p=0; for(const a of arrs){ out.set(a, p); p += a.length; } return out; }
function box(type, ...payload){ const body = concat(payload); return concat([u32(body.length + 8), enc(type), body]); }
function fullbox(type, version, flags, ...payload){ return box(type, Uint8Array.from([version, (flags>>16)&255, (flags>>8)&255, flags&255]), ...payload); }

function rle(values){ // -> [count,val] runs, returns entries array of Uint8Array pairs
  const runs = []; let i=0;
  while(i<values.length){ let j=i+1; while(j<values.length && values[j]===values[i]) j++; runs.push([j-i, values[i]]); i=j; }
  return runs;
}

// Concatenate. buffers: array of Uint8Array (whole mp4 files). opts.dedup drops each later clip's first video sample.
export function concatMp4(buffers, opts){
  const dedup = !!(opts && opts.dedup);
  const parsed = buffers.map(parseMp4);
  // gather track kinds present in clip0
  const base = parsed[0];
  const outTracks = [];
  for(let ti=0; ti<base.tracks.length; ti++){
    const kind = base.tracks[ti].kind;
    if(kind !== "video" && kind !== "audio") continue;
    const outTs = base.tracks[ti].timescale;
    const merged = { kind, timescale: outTs, stsdRaw: base.tracks[ti].stsdRaw, width: base.tracks[ti].width, height: base.tracks[ti].height, samples: [] };
    for(let ci=0; ci<parsed.length; ci++){
      const t = parsed[ci].tracks.find((x,i)=> x.kind===kind && (kind!=="video" || true) );
      if(!t){ throw new Error("clip "+ci+" missing "+kind+" track"); }
      const scale = outTs / t.timescale;
      let list = t.samples;
      if(dedup && kind==="video" && ci>0) list = list.slice(1);
      for(const s of list){
        merged.samples.push({ bufIdx: ci, offset: s.offset, size: s.size, dur: Math.round(s.dur*scale), cts: Math.round(s.cts*scale), sync: s.sync });
      }
    }
    outTracks.push(merged);
  }

  // Build mdat first so chunk offsets are known. Layout: ftyp + mdat + moov.
  const ftyp = box("ftyp", enc("isom"), u32(0x200), enc("isomiso2avc1mp41"));
  // assemble mdat data, recording each sample's absolute offset
  const mdatParts = [];
  let cursor = ftyp.length + 8; // 8 = mdat header
  for(const t of outTracks){
    for(const s of t.samples){
      s.newOffset = cursor;
      const src = buffers[s.bufIdx].subarray(s.offset, s.offset + s.size);
      mdatParts.push(src);
      cursor += s.size;
    }
  }
  const mdatData = concat(mdatParts);
  const mdat = concat([u32(mdatData.length + 8), enc("mdat"), mdatData]);

  // moov
  const mvTimescale = 1000;
  let maxDurMs = 0;
  const trakBoxes = [];
  let trackId = 1;
  for(const t of outTracks){
    const totalTicks = t.samples.reduce((a,s)=>a+s.dur, 0);
    const durMs = Math.round(totalTicks / t.timescale * mvTimescale);
    if(durMs > maxDurMs) maxDurMs = durMs;

    // stbl children
    const sttsRuns = rle(t.samples.map(s=>s.dur));
    const stts = fullbox("stts", 0, 0, u32(sttsRuns.length), ...sttsRuns.map(r=>concat([u32(r[0]), u32(r[1])])));
    const stsz = fullbox("stsz", 0, 0, u32(0), u32(t.samples.length), ...t.samples.map(s=>u32(s.size)));
    const stsc = fullbox("stsc", 0, 0, u32(1), concat([u32(1), u32(1), u32(1)]));
    const stco = fullbox("stco", 0, 0, u32(t.samples.length), ...t.samples.map(s=>u32(s.newOffset)));
    const children = [t.stsdRaw, stts];
    if(t.kind==="video"){
      const anyCts = t.samples.some(s=>s.cts!==0);
      if(anyCts){ const cttsRuns = rle(t.samples.map(s=>s.cts)); children.push(fullbox("ctts", 0, 0, u32(cttsRuns.length), ...cttsRuns.map(r=>concat([u32(r[0]), u32(r[1]>>>0)])))); }
      const syncIdx = []; t.samples.forEach((s,i)=>{ if(s.sync) syncIdx.push(i+1); });
      if(syncIdx.length && syncIdx.length !== t.samples.length) children.push(fullbox("stss", 0, 0, u32(syncIdx.length), ...syncIdx.map(u32)));
    }
    children.push(stsc, stsz, stco);
    const stbl = box("stbl", ...children);

    const mediaHeader = t.kind==="video"
      ? box("vmhd", Uint8Array.from([0,0,0,1]), new Uint8Array(8))
      : box("smhd", new Uint8Array(8));
    const dref = fullbox("dref", 0, 0, u32(1), fullbox("url ", 0, 1));
    const dinf = box("dinf", dref);
    const minf = box("minf", mediaHeader, dinf, stbl);

    const hdlrName = enc(t.kind==="video" ? "VideoHandler\0" : "SoundHandler\0");
    const hdlr = fullbox("hdlr", 0, 0, u32(0), enc(t.kind==="video"?"vide":"soun"), new Uint8Array(12), hdlrName);
    const mdhd = fullbox("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(totalTicks), Uint8Array.from([0x55,0xc4,0,0]));
    const mdia = box("mdia", mdhd, hdlr, minf);

    // tkhd (enabled+in_movie flags=7)
    const w = (t.width||0), h = (t.height||0);
    const tkhdBody = concat([
      u32(0), u32(0), u32(trackId), u32(0), u32(durMs),
      new Uint8Array(8), u16(0), u16(0), u16(t.kind==="audio"?0x0100:0), u16(0),
      // matrix
      concat([u32(0x00010000),u32(0),u32(0),u32(0),u32(0x00010000),u32(0),u32(0),u32(0),u32(0x40000000)]),
      u32(w<<16), u32(h<<16)
    ]);
    const tkhd = fullbox("tkhd", 0, 7, tkhdBody);
    trakBoxes.push(box("trak", tkhd, mdia));
    trackId++;
  }
  const mvhd = fullbox("mvhd", 0, 0, u32(0), u32(0), u32(mvTimescale), u32(maxDurMs),
    u32(0x00010000), u16(0x0100), u16(0), new Uint8Array(8),
    concat([u32(0x00010000),u32(0),u32(0),u32(0),u32(0x00010000),u32(0),u32(0),u32(0),u32(0x40000000)]),
    new Uint8Array(24), u32(trackId));
  const moov = box("moov", mvhd, ...trakBoxes);

  return concat([ftyp, mdat, moov]);
}

// quick sniff
export function isMp4(u8){ if(u8.length<12) return false; const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength); return fourcc(dv,4)==="ftyp"; }

function bytesEqual(a, b){ if(!a || !b || a.length !== b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; }

// Strict gate: every clip must have the same track shape and byte-identical codec config
// (avcC / esds live in stsd). A false positive silently corrupts output, so default to NO on any doubt.
export function mp4ParamsMatch(bufs){
  try{
    if(bufs.length < 2) return false;
    const ps = bufs.map(parseMp4);
    const sig = (p)=>{
      const vids = p.tracks.filter(t=>t.kind==="video");
      const auds = p.tracks.filter(t=>t.kind==="audio");
      if(vids.length !== 1) return null;                 // need exactly one video track
      if(auds.length > 1) return null;
      return { v: vids[0], a: auds[0] || null, na: auds.length };
    };
    const base = sig(ps[0]); if(!base) return false;
    for(let i=1;i<ps.length;i++){
      const s = sig(ps[i]); if(!s) return false;
      if(s.na !== base.na) return false;                 // all-or-none audio
      if(s.v.width !== base.v.width || s.v.height !== base.v.height) return false;
      if(!bytesEqual(s.v.codecCfg, base.v.codecCfg)) return false;   // same video SPS/PPS (avcC)
      if(base.a && (s.a.sampleRate !== base.a.sampleRate || s.a.channels !== base.a.channels)) return false; // audio concat-compatible
    }
    return true;
  }catch(e){ return false; }
}
