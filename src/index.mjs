/* mp4cat — lossless mp4 concatenation.
   Copies the compressed samples from each clip onto one timeline and writes a single mp4:
   no decode/re-encode, no MediaRecorder, no AudioContext. Duration is exact by construction.
   Use when every clip is mp4 with matching codec params (see mp4Compat / mp4ParamsMatch).
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

// codec config box candidates per track kind — the equality signal for the match gate,
// excluding clip-specific sample-entry boxes (btrt etc) that differ by content.
const CFG_BOXES = { video: ["avcC", "hvcC", "vpcC", "av1C"], audio: ["esds", "dOps", "alac"] };

// Parse one mp4 into { fragmented, tracks:[{kind, trackId, timescale, stsdRaw, sampleEntry,
// codecCfg, codecCfgType, samples:[{offset,size,dur,cts,sync}], width,height, channels,sampleRate}] }.
// Reads both classic moov sample tables and moof/traf/trun fragments (fMP4/CMAF).
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
    if(!hdlr) continue; // can't classify a trak without a handler
    const handler = fourcc(dv, hdlr.body + 8); // after ver/flags(4)+pre_defined(4)
    const kind = handler === "vide" ? "video" : handler === "soun" ? "audio" : handler;
    // A damaged media trak must fail loudly: silently skipping it would let a broken clip pass
    // the gate as audio-only/video-only and drop a whole stream. Non-media traks skip quietly.
    const isMedia = kind === "video" || kind === "audio";
    const damaged = (what) => { throw new Error(kind + " trak is missing " + what + " (damaged file?)"); };
    if(!mdhd){ if(isMedia) damaged("mdhd"); continue; }
    const mdhdV1 = dv.getUint8(mdhd.body) === 1;
    // v0: [ver/flags 4][ctime 4][mtime 4][timescale 4]; v1: [ver/flags 4][ctime 8][mtime 8][timescale 4]
    const timescale = dv.getUint32(mdhd.body + (mdhdV1 ? 20 : 12));
    const minf = find(mb, "minf"); if(!minf){ if(isMedia) damaged("minf"); continue; }
    const minfB = walk(dv, minf.body, minf.end);
    const stbl = find(minfB, "stbl"); if(!stbl){ if(isMedia) damaged("stbl"); continue; }
    const sb = walk(dv, stbl.body, stbl.end);
    const stsd = find(sb, "stsd"); if(!stsd){ if(isMedia) damaged("stsd"); continue; }
    const stsdRaw = u8.slice(stsd.start, stsd.end); // whole stsd box, copied verbatim into output
    // first sample entry's 4cc: stsd hdr(8) + ver/flags(4) + entry_count(4) + entry size(4) → type at 20
    const sampleEntry = stsdRaw.length >= 24 ? String.fromCharCode(stsdRaw[20], stsdRaw[21], stsdRaw[22], stsdRaw[23]) : "????";
    let codecCfg = null, codecCfgType = null;
    for(const cc of (CFG_BOXES[kind] || [...CFG_BOXES.video, ...CFG_BOXES.audio])){
      codecCfg = scanForBox(stsdRaw, cc);
      if(codecCfg){ codecCfgType = cc; break; }
    }
    // video dims from tkhd (16.16 fixed at the end of the box, same position for v0/v1)
    let width = 0, height = 0, trackId = tracks.length + 1;
    const tkhd = find(tb, "tkhd");
    if(tkhd){
      const tkhdV1 = dv.getUint8(tkhd.body) === 1;
      trackId = dv.getUint32(tkhd.body + (tkhdV1 ? 20 : 12));
      if(kind === "video"){ width = dv.getUint16(tkhd.end - 8); height = dv.getUint16(tkhd.end - 4); }
    }
    // audio rate/channels from the mp4a-style sample entry (esds carries clip-specific bitrate, so
    // it's not a stable equality signal — rate+channels is what decides concat compatibility).
    let channels = 0, sampleRate = 0;
    if(kind === "audio" && stsdRaw.length >= 52){
      const adv = new DataView(stsdRaw.buffer, stsdRaw.byteOffset, stsdRaw.byteLength);
      channels = adv.getUint16(16 + 24); sampleRate = adv.getUint16(16 + 32); // relative to sample entry at 16
    }

    // --- sample tables (all-empty in fragmented files with empty_moov) ---
    const stts = find(sb, "stts"), stsc = find(sb, "stsc"), stsz = find(sb, "stsz");
    const stco = find(sb, "stco"), co64 = find(sb, "co64"), ctts = find(sb, "ctts"), stss = find(sb, "stss");

    // stsz
    const stszSampleSize = stsz ? dv.getUint32(stsz.body + 4) : 0;
    const sampleCount = stsz ? dv.getUint32(stsz.body + 8) : 0;
    const sizes = new Array(sampleCount);
    if(stszSampleSize === 0){ for(let i=0;i<sampleCount;i++) sizes[i] = dv.getUint32(stsz.body + 12 + i*4); }
    else sizes.fill(stszSampleSize);

    // stts -> per-sample duration
    const sttsN = stts ? dv.getUint32(stts.body + 4) : 0;
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
    const coN = co ? dv.getUint32(co.body + 4) : 0;
    const chunkOffsets = new Array(coN);
    for(let e=0;e<coN;e++) chunkOffsets[e] = is64 ? Number(dv.getBigUint64(co.body + 8 + e*8)) : dv.getUint32(co.body + 8 + e*4);

    // stsc -> samples per chunk
    const stscN = stsc ? dv.getUint32(stsc.body + 4) : 0;
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
    tracks.push({ kind, trackId, timescale, stsdRaw, sampleEntry, codecCfg, codecCfgType, samples, width, height, channels, sampleRate });
  }

  // trex: movie-level per-track defaults for fragments
  const trexById = new Map();
  const mvex = find(moovBoxes, "mvex");
  if(mvex){
    for(const tx of walk(dv, mvex.body, mvex.end).filter(b => b.type === "trex")){
      trexById.set(dv.getUint32(tx.body + 4), { dur: dv.getUint32(tx.body + 12), size: dv.getUint32(tx.body + 16), flags: dv.getUint32(tx.body + 20) });
    }
  }
  const moofs = top.filter(b => b.type === "moof");
  if(moofs.length){
    const byId = new Map(tracks.map(t => [t.trackId, t]));
    for(const moof of moofs) parseMoof(dv, moof, byId, trexById);
  }
  // every sample must live inside the file — a truncated download parses fine up to here but
  // its mdat is cut, and copying clamped subarrays would silently emit a corrupt output
  for(const t of tracks){
    for(const s of t.samples){
      if(s.offset + s.size > u8.byteLength) throw new Error(t.kind + " samples extend past end of file (truncated file?)");
    }
  }
  return { tracks, fragmented: moofs.length > 0 };
}

// Append one moof's samples to their tracks. Handles tfhd/trex defaults, explicit /
// default-base-is-moof / carry-forward base data offsets, and v0/v1 trun composition offsets.
function parseMoof(dv, moof, byId, trexById){
  let carry = moof.start; // default base for the first traf; advances past each traf's data
  for(const traf of walk(dv, moof.body, moof.end).filter(b => b.type === "traf")){
    const tb = walk(dv, traf.body, traf.end);
    const tfhd = find(tb, "tfhd"); if(!tfhd) continue;
    const tfFlags = dv.getUint32(tfhd.body) & 0xffffff;
    const trackId = dv.getUint32(tfhd.body + 4);
    const track = byId.get(trackId);
    const trex = trexById.get(trackId) || { dur: 0, size: 0, flags: 0 };
    let p = tfhd.body + 8, base = null;
    if(tfFlags & 0x01){ base = Number(dv.getBigUint64(p)); p += 8; }
    if(tfFlags & 0x02) p += 4; // sample_description_index
    let defDur = trex.dur, defSize = trex.size, defFlags = trex.flags;
    if(tfFlags & 0x08){ defDur = dv.getUint32(p); p += 4; }
    if(tfFlags & 0x10){ defSize = dv.getUint32(p); p += 4; }
    if(tfFlags & 0x20){ defFlags = dv.getUint32(p); p += 4; }
    if(base === null) base = (tfFlags & 0x20000) ? moof.start : carry; // 0x20000 = default-base-is-moof
    let pos = base;
    for(const trun of tb.filter(b => b.type === "trun")){
      const ver = dv.getUint8(trun.body);
      const trFlags = dv.getUint32(trun.body) & 0xffffff;
      const n = dv.getUint32(trun.body + 4);
      let q = trun.body + 8, firstFlags = null;
      if(trFlags & 0x1){ pos = base + dv.getInt32(q); q += 4; }
      if(trFlags & 0x4){ firstFlags = dv.getUint32(q); q += 4; }
      for(let i=0;i<n;i++){
        let dur = defDur, size = defSize, flags = defFlags, cts = 0;
        if(trFlags & 0x100){ dur = dv.getUint32(q); q += 4; }
        if(trFlags & 0x200){ size = dv.getUint32(q); q += 4; }
        if(trFlags & 0x400){ flags = dv.getUint32(q); q += 4; }
        else if(i === 0 && firstFlags !== null) flags = firstFlags;
        if(trFlags & 0x800){ cts = ver ? dv.getInt32(q) : dv.getUint32(q); q += 4; }
        if(track) track.samples.push({ offset: pos, size, dur, cts, sync: !((flags >>> 16) & 1) });
        pos += size;
      }
    }
    carry = pos;
  }
}

// ---- box writers ----
const enc = (s) => Uint8Array.from(s, c => c.charCodeAt(0));
function u32(n){ const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n>>>0); return a; }
function u16(n){ const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, n & 0xffff); return a; }
function u64(n){ const a = new Uint8Array(8); new DataView(a.buffer).setBigUint64(0, BigInt(n)); return a; }
// one packed big-endian u32 array — sample tables can run to hundreds of thousands of entries,
// far past V8's max argument count, so they must never be spread into box()/fullbox()
function u32Table(values){ const a = new Uint8Array(values.length*4); const dv = new DataView(a.buffer); for(let i=0;i<values.length;i++) dv.setUint32(i*4, values[i]>>>0); return a; }
function concat(arrs){ let len=0; for(const a of arrs) len += a.length; const out = new Uint8Array(len); let p=0; for(const a of arrs){ out.set(a, p); p += a.length; } return out; }
function box(type, ...payload){ const body = concat(payload); return concat([u32(body.length + 8), enc(type), body]); }
function fullbox(type, version, flags, ...payload){ return box(type, Uint8Array.from([version, (flags>>16)&255, (flags>>8)&255, flags&255]), ...payload); }

function rle(values){ // -> [count,val] runs
  const runs = []; let i=0;
  while(i<values.length){ let j=i+1; while(j<values.length && values[j]===values[i]) j++; runs.push([j-i, values[i]]); i=j; }
  return runs;
}

// Concatenate. buffers: array of Uint8Array (whole mp4 files). opts.dedup drops each later clip's
// first video sample. Output is streamable: moov before mdat (faststart), samples interleaved
// across tracks in ~0.5 s chunks so playback never waits on a far-away byte range.
export function concatMp4(buffers, opts){
  const dedup = !!(opts && opts.dedup);
  const parsed = buffers.map(parseMp4);
  // gather track kinds present in clip0
  const base = parsed[0];
  const outTracks = [];
  for(let ti=0; ti<base.tracks.length; ti++){
    const kind = base.tracks[ti].kind;
    if(kind !== "video" && kind !== "audio") continue;
    const nth = base.tracks.slice(0, ti).filter(x => x.kind === kind).length;
    const outTs = base.tracks[ti].timescale;
    const merged = { kind, timescale: outTs, stsdRaw: base.tracks[ti].stsdRaw, width: base.tracks[ti].width, height: base.tracks[ti].height, samples: [] };
    for(let ci=0; ci<parsed.length; ci++){
      const t = parsed[ci].tracks.filter(x => x.kind === kind)[nth];
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
  if(!outTracks.length) throw new Error("no audio or video tracks in clip 0");
  if(outTracks.some(t => !t.samples.length)) throw new Error("a track has no samples (fragmented file without fragments?)");

  // interleave samples into chunks by decode time
  const INTERLEAVE_S = 0.5;
  for(const t of outTracks){ let dts = 0; for(const s of t.samples){ s.t = dts / t.timescale; dts += s.dur; } }
  const idx = outTracks.map(() => 0);
  const chunks = []; // { ti, samples }
  for(;;){
    let ti = -1, best = Infinity;
    for(let k=0;k<outTracks.length;k++){
      if(idx[k] < outTracks[k].samples.length && outTracks[k].samples[idx[k]].t < best){ best = outTracks[k].samples[idx[k]].t; ti = k; }
    }
    if(ti < 0) break;
    const list = outTracks[ti].samples, chunk = [];
    while(idx[ti] < list.length && list[idx[ti]].t < best + INTERLEAVE_S) chunk.push(list[idx[ti]++]);
    chunks.push({ ti, samples: chunk });
  }

  let mdatSize = 0;
  for(const t of outTracks) for(const s of t.samples) mdatSize += s.size;

  // only claim avc1 brand compatibility when there is actually an AVC track
  const hasAvc = outTracks.some(t => t.kind === "video" && scanForBox(t.stsdRaw, "avcC"));
  const ftyp = box("ftyp", enc("isom"), u32(0x200), enc(hasAvc ? "isomiso2avc1mp41" : "isomiso2mp41"));
  const mvTimescale = 1000;

  // moov size does not depend on the offset VALUES in stco (fixed 4 bytes each), so build once
  // with dataStart=0 to learn the size, then again with real offsets. Layout: ftyp + moov + mdat.
  function buildMoov(dataStart){
    let off = dataStart;
    const chunkOff = chunks.map(c => { const o = off; for(const s of c.samples) off += s.size; return o; });
    if(off > 0xffffffff) throw new Error("output exceeds 4 GiB — mp4cat writes 32-bit chunk offsets");
    let maxDurMs = 0, trackId = 1;
    const trakBoxes = [];
    for(let k=0;k<outTracks.length;k++){
      const t = outTracks[k];
      const totalTicks = t.samples.reduce((a,s)=>a+s.dur, 0);
      const durMs = Math.round(totalTicks / t.timescale * mvTimescale);
      if(durMs > maxDurMs) maxDurMs = durMs;

      // stbl children
      const myChunks = []; // [offset, samplesPerChunk] in this track's chunk order
      chunks.forEach((c,i)=>{ if(c.ti===k) myChunks.push([chunkOff[i], c.samples.length]); });
      const stscVals = []; let first = 1;
      for(const r of rle(myChunks.map(c=>c[1]))){ stscVals.push(first, r[1], 1); first += r[0]; }
      const stsc = fullbox("stsc", 0, 0, u32(stscVals.length/3), u32Table(stscVals));
      const stco = fullbox("stco", 0, 0, u32(myChunks.length), u32Table(myChunks.map(c=>c[0])));
      const sttsRuns = rle(t.samples.map(s=>s.dur));
      const stts = fullbox("stts", 0, 0, u32(sttsRuns.length), u32Table(sttsRuns.flat()));
      const stsz = fullbox("stsz", 0, 0, u32(0), u32(t.samples.length), u32Table(t.samples.map(s=>s.size)));
      const children = [t.stsdRaw, stts];
      if(t.kind==="video"){
        const anyCts = t.samples.some(s=>s.cts!==0);
        if(anyCts){
          const cttsVer = t.samples.some(s=>s.cts<0) ? 1 : 0; // v0 is unsigned; negatives need v1
          const cttsRuns = rle(t.samples.map(s=>s.cts));
          children.push(fullbox("ctts", cttsVer, 0, u32(cttsRuns.length), u32Table(cttsRuns.flat())));
        }
        const syncIdx = []; t.samples.forEach((s,i)=>{ if(s.sync) syncIdx.push(i+1); });
        // when NO sample is sync, an explicit empty stss is required — omitting the box means "all sync"
        if(syncIdx.length !== t.samples.length) children.push(fullbox("stss", 0, 0, u32(syncIdx.length), u32Table(syncIdx)));
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
      // v1 mdhd (64-bit duration) when the tick count outgrows u32 — high-timescale tracks
      // (e.g. 1 MHz) pass 2^32 ticks in ~71 minutes, far below any byte-size limit
      const mdhd = totalTicks > 0xffffffff
        ? fullbox("mdhd", 1, 0, new Uint8Array(16), u32(t.timescale), u64(totalTicks), Uint8Array.from([0x55,0xc4,0,0]))
        : fullbox("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(totalTicks), Uint8Array.from([0x55,0xc4,0,0]));
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
    return box("moov", mvhd, ...trakBoxes);
  }

  const probe = buildMoov(0);
  const dataStart = ftyp.length + probe.length + 8; // 8 = mdat header
  const moov = buildMoov(dataStart);
  if(moov.length !== probe.length) throw new Error("internal: moov size changed between passes");
  const parts = [ftyp, moov, u32(mdatSize + 8), enc("mdat")];
  for(const c of chunks) for(const s of c.samples) parts.push(buffers[s.bufIdx].subarray(s.offset, s.offset + s.size));
  return concat(parts);
}

// quick sniff
export function isMp4(u8){ if(u8.length<12) return false; const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength); return fourcc(dv,4)==="ftyp"; }

function bytesEqual(a, b){ if(!a || !b || a.length !== b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; }

// Comparable audio decoder-config signature. Whole-esds comparison would false-reject same-encoder
// clips (DecoderConfigDescriptor carries per-clip bufferSizeDB/maxBitrate/avgBitrate), so for esds
// we compare only objectTypeIndication + DecoderSpecificInfo (the AudioSpecificConfig — profile,
// frame length, SBR signaling: what actually decides decode compatibility). dOps has no per-clip
// fields and compares whole. alac carries avgBitRate/maxFrameBytes → null (rate/channel gate only).
function audioCfgSig(cfg, type){
  if(!cfg) return null;
  if(type === "dOps") return cfg;
  if(type !== "esds") return null;
  try{
    let p = 12; // box hdr(8) + ver/flags(4)
    const len = () => { let l = 0, b; do{ b = cfg[p++]; l = (l<<7) | (b & 0x7f); }while(b & 0x80); return l; };
    if(cfg[p++] !== 0x03) return null; len();
    p += 2; const f = cfg[p++]; // ES_ID(2) + flags
    if(f & 0x80) p += 2;              // dependsOn_ES_ID
    if(f & 0x40) p += 1 + cfg[p];     // URL
    if(f & 0x20) p += 2;              // OCR_ES_ID
    if(cfg[p++] !== 0x04) return null;
    len();
    const oti = cfg[p]; p += 13; // OTI(1)+streamType(1)+bufferSizeDB(3)+maxBitrate(4)+avgBitrate(4)
    if(p >= cfg.length || cfg[p++] !== 0x05) return Uint8Array.of(oti); // no ASC → OTI only
    const dsLen = len();
    const out = new Uint8Array(1 + dsLen); out[0] = oti; out.set(cfg.subarray(p, p + dsLen), 1);
    return out;
  }catch(e){ return null; }
}

// Strict gate with a human-readable verdict: { ok, reason }. reason is null when ok, otherwise one
// sentence naming the first offending clip and what differs. A false positive silently corrupts
// output, so default to NO on any doubt. opts.names labels clips in reasons (e.g. filenames).
export function mp4Compat(bufs, opts){
  const name = (i) => (opts && opts.names && opts.names[i]) || ("clip " + (i+1));
  const no = (reason) => ({ ok: false, reason });
  if(!bufs || bufs.length < 2) return no("need at least two clips to concatenate");
  const ps = [];
  for(let i=0;i<bufs.length;i++){
    try{ ps.push(parseMp4(bufs[i])); }
    catch(e){ return no(name(i) + " is not a parseable mp4 (" + (e && e.message || e) + ")"); }
  }
  const shape = (p) => ({ v: p.tracks.filter(t=>t.kind==="video"), a: p.tracks.filter(t=>t.kind==="audio") });
  const b = shape(ps[0]);
  if(b.v.length > 1) return no(name(0) + " has " + b.v.length + " video tracks (mp4cat handles at most one)");
  if(b.a.length > 1) return no(name(0) + " has " + b.a.length + " audio tracks (mp4cat handles at most one)");
  if(!b.v.length && !b.a.length) return no(name(0) + " has no video or audio track");
  for(let i=0;i<ps.length;i++){
    const s = i ? shape(ps[i]) : b;
    if(s.v.length !== b.v.length) return no(name(i) + " has " + s.v.length + " video track(s) but " + name(0) + " has " + b.v.length + " (video must be all-or-none, at most one)");
    if(s.a.length !== b.a.length) return no(name(i) + " has " + s.a.length + " audio track(s) but " + name(0) + " has " + b.a.length + " (audio must be all-or-none, at most one)");
    for(const t of [...s.v, ...s.a]){
      if(!t.samples.length) return no(name(i) + "'s " + t.kind + " track has no samples");
    }
    if(i === 0) continue;
    if(s.v.length){
      const v = s.v[0], bv = b.v[0];
      if(v.sampleEntry !== bv.sampleEntry) return no(name(i) + " video is " + v.sampleEntry + " but " + name(0) + " is " + bv.sampleEntry + " — re-encode to one codec first");
      if(v.width !== bv.width || v.height !== bv.height) return no(name(i) + " is " + v.width + "x" + v.height + " but " + name(0) + " is " + bv.width + "x" + bv.height + " — re-encode to one resolution first");
      if(!v.codecCfg || !bv.codecCfg) return no("couldn't find a codec configuration (" + CFG_BOXES.video.join("/") + ") in " + name(v.codecCfg ? 0 : i));
      if(!bytesEqual(v.codecCfg, bv.codecCfg)) return no(name(i) + "'s video codec configuration (" + v.codecCfgType + ", e.g. SPS/PPS) differs from " + name(0) + "'s — re-encode with identical encoder settings first");
    }
    if(s.a.length){
      const a = s.a[0], ba = b.a[0];
      if(a.sampleEntry !== ba.sampleEntry) return no(name(i) + " audio is " + a.sampleEntry + " but " + name(0) + " is " + ba.sampleEntry + " — re-encode to one codec first");
      if(a.sampleRate !== ba.sampleRate) return no(name(i) + " audio is " + a.sampleRate + " Hz but " + name(0) + " is " + ba.sampleRate + " Hz — resample first");
      if(a.channels !== ba.channels) return no(name(i) + " audio has " + a.channels + " channel(s) but " + name(0) + " has " + ba.channels);
      const sig = audioCfgSig(a.codecCfg, a.codecCfgType), bsig = audioCfgSig(ba.codecCfg, ba.codecCfgType);
      if((sig || bsig) && !bytesEqual(sig, bsig)) return no(name(i) + "'s audio decoder configuration differs from " + name(0) + "'s (e.g. AAC-LC vs HE-AAC) — re-encode with identical encoder settings first");
    }
  }
  return { ok: true, reason: null };
}

// boolean form of mp4Compat, kept for back-compat. Needs ≥ 2 buffers.
export function mp4ParamsMatch(bufs){
  try{ return mp4Compat(bufs).ok; }catch(e){ return false; }
}

const CODEC_NAMES = { avc1:"h264", avc3:"h264", hvc1:"h265", hev1:"h265", vp09:"vp9", av01:"av1", mp4a:"aac", Opus:"opus", alac:"alac", "ac-3":"ac3", "ec-3":"eac3" };

// Friendly probe: durations, codecs, dimensions, rates — no ffprobe needed.
export function mp4Info(u8){
  const p = parseMp4(u8);
  const tracks = p.tracks.filter(t => t.kind==="video" || t.kind==="audio").map(t => {
    const ticks = t.samples.reduce((a,s)=>a+s.dur, 0);
    const duration = t.timescale ? ticks / t.timescale : 0;
    const base = { kind: t.kind, codec: t.sampleEntry, codecName: CODEC_NAMES[t.sampleEntry] || t.sampleEntry, duration, timescale: t.timescale, sampleCount: t.samples.length };
    return t.kind === "video"
      ? { ...base, width: t.width, height: t.height, fps: duration > 0 ? Math.round(t.samples.length / duration * 100) / 100 : 0 }
      : { ...base, channels: t.channels, sampleRate: t.sampleRate };
  });
  return { fragmented: p.fragmented, duration: tracks.reduce((m,t)=>Math.max(m,t.duration), 0), tracks };
}
