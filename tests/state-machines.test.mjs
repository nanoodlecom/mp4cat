import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir, chmod, stat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = promisify(execFile);
const cli = new URL('../bin/mp4cat.mjs', import.meta.url).pathname;
import { parseMp4, mp4Compat, concatMp4 } from '../src/index.mjs';

const cat = (...parts) => Uint8Array.from(parts.flatMap(p => [...p]));
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const box = (type, ...body) => { const b = cat(...body); return cat(u32(b.length + 8), new TextEncoder().encode(type), b); };
const full = (type, flags, ...body) => box(type, u32(flags), ...body);

// A tiny structural fixture: real sample tables, arbitrary payload (no decoder required).
function fixture({ fragmented = false, timescale = 30, duration = 1, cts = 0,
  sttsCount = 1, offset = null, description = 1, runs = 1, secondDts = duration * runs, baseMode = 'moof', trackId = 1,
  fragmentTrackId = 1, handler = 'vide', extendedStsd = false } = {}) {
  const ftyp = box('ftyp', new TextEncoder().encode('isom'), u32(0));
  const standardStsd = full('stsd', 0, u32(1), box('avc1', new Uint8Array(78), box('avcC', Uint8Array.of(1, 100, 0, 31))));
  const stsd = extendedStsd ? cat(u32(1), new TextEncoder().encode('stsd'), u32(0), u32(standardStsd.length + 8), standardStsd.slice(8)) : standardStsd;
  const moov = dataOffset => box('moov', box('trak',
    full('tkhd', 7, u32(0), u32(0), u32(trackId), new Uint8Array(60), u32(16 << 16), u32(16 << 16)),
    box('mdia', full('mdhd', 0, u32(0), u32(0), u32(timescale), u32(1), u32(0)),
      full('hdlr', 0, u32(0), new TextEncoder().encode(handler), new Uint8Array(12)),
      box('minf', box('stbl', stsd,
        full('stts', 0, u32(fragmented ? 0 : 1), ...(fragmented ? [] : [u32(sttsCount), u32(duration)])),
        ...(cts ? [full('ctts', 0, u32(1), u32(1), u32(cts))] : []),
        full('stsc', 0, u32(fragmented ? 0 : 1), ...(fragmented ? [] : [u32(1), u32(1), u32(description)])),
        full('stsz', 0, u32(4), u32(fragmented ? 0 : 1)),
        full('stco', 0, u32(fragmented ? 0 : 1), ...(fragmented ? [] : [u32(offset ?? dataOffset)]))
      )))), ...(fragmented ? [box('mvex', full('trex', 0, u32(trackId), u32(description), u32(duration), u32(4), u32(0)))] : []));
  const m = moov(0);
  if(!fragmented) return cat(ftyp, moov(ftyp.length + m.length + 8), box('mdat', u32(42)));
  const fragment = (dts, start) => {
    const make = dataOffset => box('moof', box('traf',
      full('tfhd', baseMode === 'explicit' ? 1 : baseMode === 'moof' ? 0x20000 : 0,
        u32(fragmentTrackId), ...(baseMode === 'explicit' ? [u32(0), u32(start)] : [])),
      full('tfdt', 0, u32(dts)),
      ...Array.from({ length: runs }, (_, i) => full('trun', i ? 0 : 1, u32(1), ...(i ? [] : [u32(offset ?? dataOffset)])))));
    return cat(make(make(0).length + 8), box('mdat', ...Array.from({ length: runs }, () => u32(42))));
  };
  const first = fragment(0, ftyp.length + m.length);
  return cat(ftyp, m, first, fragment(secondDts, ftyp.length + m.length + first.length));
}

function rejected(bytes, reason) {
  assert.throws(() => parseMp4(bytes), reason);
  const gate = mp4Compat([bytes, bytes]);
  assert.equal(gate.ok, false);
}

test('structural progressive and contiguous fragmented fixtures round-trip', () => {
  for(const bytes of [fixture(), fixture({ fragmented: true })]) {
    assert.equal(mp4Compat([bytes, bytes]).ok, true);
    const parsed = parseMp4(bytes);
    assert.equal(parseMp4(concatMp4([bytes, bytes])).tracks[0].samples.length, parsed.tracks[0].samples.length * 2);
  }
});

test('zero timescale and zero sample duration cannot enter the interleaver', () => {
  rejected(fixture({ timescale: 0 }), /timescale/);
  rejected(fixture({ duration: 0 }), /duration/);
});

test('sample offsets must refer to mdat payload, including signed fragment offsets', () => {
  rejected(fixture({ offset: 0 }), /mdat/);
  rejected(fixture({ fragmented: true, offset: 0x80000000 }), /offset|mdat/);
});

test('sample timing runs must cover the declared samples exactly', () => {
  rejected(fixture({ sttsCount: 0 }), /stts/);
  rejected(fixture({ sttsCount: 2 }), /stts/);
});

test('unsupported sample description transitions are rejected', () => {
  rejected(fixture({ description: 2 }), /description/);
  rejected(fixture({ fragmented: true, description: 2 }), /description/);
});

test('fragment decode timeline gaps, overlaps, and unknown tracks are rejected', () => {
  rejected(fixture({ fragmented: true, secondDts: 3 }), /timeline|decode/);
  rejected(fixture({ fragmented: true, secondDts: 0 }), /timeline|decode/);
  rejected(fixture({ fragmented: true, fragmentTrackId: 2 }), /track/);
});

test('version 0 composition offsets are unsigned and remain unsigned after concat', () => {
  const bytes = fixture({ cts: 0x80000000 });
  assert.equal(parseMp4(bytes).tracks[0].samples[0].cts, 0x80000000);
  assert.equal(parseMp4(concatMp4([bytes, bytes])).tracks[0].samples[0].cts, 0x80000000);
});

test('compatibility refuses extra non-media tracks instead of silently dropping them', () => {
  const bytes = fixture({ handler: 'text', trackId: 2 });
  // A media clip plus an extra trak should fail even if all clips share the same shape.
  const media = fixture();
  const dv = new DataView(bytes.buffer);
  const moovStart = 16;
  const trak = bytes.slice(moovStart + 8, moovStart + dv.getUint32(moovStart));
  const mediaMoovSize = new DataView(media.buffer).getUint32(16);
  const combined = cat(media.slice(0, 16), box('moov', media.slice(24, 16 + mediaMoovSize), trak), media.slice(16 + mediaMoovSize));
  // Fix the media chunk offset after adding the extra trak.
  let at = -1;
  while((at = Buffer.from(combined).indexOf('stco', at + 1)) !== -1) new DataView(combined.buffer).setUint32(at + 12, combined.length - 4);
  assert.equal(parseMp4(combined).tracks.length, 2);
  assert.match(mp4Compat([combined, combined]).reason, /unsupported non-media tracks/);
});

test('truncated boxes and tables fail at their own boundary', () => {
  rejected(cat(fixture(), Uint8Array.of(0, 0, 0)), /box|truncated/);
  const bytes = fixture();
  const at = Buffer.from(bytes).indexOf('stsz');
  new DataView(bytes.buffer).setUint32(at + 12, 0xffffffff);
  rejected(bytes, /sample|stsz/);
});

test('concat reports empty input and refuses unrepresentable output timing', () => {
  assert.throws(() => concatMp4([]), /at least/);
  const a = fixture({ timescale: 1 });
  const b = fixture({ timescale: 0xffffffff });
  assert.throws(() => concatMp4([a, b]), /duration|rescal/);
  assert.throws(() => concatMp4([fixture({ timescale: 1, duration: 0xffffffff })]), /duration/);
});


test('CLI publishes complete output and preserves existing output on write failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mp4cat-atomic-'));
  try{
    const input = join(dir, 'input.mp4'), output = join(dir, 'output.mp4');
    await writeFile(input, fixture());
    await writeFile(output, 'previous output');
    await chmod(output, 0o640);
    const preload = join(dir, 'fail-write.mjs');
    await writeFile(preload, `import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.writeFile;
      fs.writeFile = async (path, bytes, opts) => {
        await original(path, bytes.subarray(0, 8), opts);
        throw new Error('injected write failure');
      };
      syncBuiltinESMExports();`);
    await assert.rejects(run(process.execPath, ['--import', preload, cli, input, input, '-o', output]), e => {
      assert.match(e.stderr, /injected write failure/); return true;
    });
    assert.equal(await readFile(output, 'utf8'), 'previous output');
    assert.equal((await readdir(dir)).some(n => n.startsWith('.mp4cat-')), false);
    await run(process.execPath, [cli, input, input, '-o', output]);
    assert.equal(parseMp4(new Uint8Array(await readFile(output))).tracks[0].samples.length, 2);
    assert.equal((await stat(output)).mode & 0o777, 0o640);
    const link = join(dir, 'link.mp4');
    await symlink(output, link);
    await run(process.execPath, [cli, input, input, '-o', link]);
    assert.equal(parseMp4(new Uint8Array(await readFile(output))).tracks[0].samples.length, 2);
    const badOutput = join(dir, 'directory');
    await mkdir(badOutput);
    await writeFile(join(badOutput, 'sentinel'), 'keep');
    await assert.rejects(run(process.execPath, [cli, input, input, '-o', badOutput]), /regular file/);
    assert.equal(await readFile(join(badOutput, 'sentinel'), 'utf8'), 'keep');
    assert.equal((await readdir(dir)).some(n => n.startsWith('.mp4cat-')), false);
  }finally{ await rm(dir, { recursive: true, force: true }); }
});


test('extended headers, field bounds, and fragment run counts fail closed', () => {
  rejected(cat(u32(1), new TextEncoder().encode('moov')), /extended box header/);
  for(const [fourcc, relative, value, reason] of [
    ['stts', -4, 16, /box/], // malformed sibling layout cannot be silently truncated
    ['stsd', 8, 2, /description/],
    ['stsc', 8, 2, /stsc/],
    ['trun', 8, 0xffffffff, /sample count/],
    ['tfhd', 4, 0x02000000, /version/],
  ]){
    const bytes = fixture({ fragmented: ['trun', 'tfhd'].includes(fourcc) });
    const at = Buffer.from(bytes).indexOf(fourcc);
    new DataView(bytes.buffer).setUint32(at + relative, value);
    rejected(bytes, reason);
  }
});


test('fragment base offsets and implicit run continuation preserve every sample', () => {
  for(const baseMode of ['moof', 'explicit', 'implicit']){
    const bytes = fixture({ fragmented: true, runs: 2, baseMode });
    const track = parseMp4(bytes).tracks[0];
    assert.equal(track.samples.length, 4);
    for(const sample of track.samples) assert.equal(new DataView(bytes.buffer).getUint32(sample.offset), 42);
    const output = concatMp4([bytes, bytes]);
    assert.equal(parseMp4(output).tracks[0].samples.length, 8);
  }
});


test('extended stsd headers preserve sample-entry identity through remuxing', () => {
  const bytes = fixture({ extendedStsd: true });
  assert.equal(parseMp4(bytes).tracks[0].sampleEntry, 'avc1');
  assert.equal(mp4Compat([fixture(), bytes]).ok, true);
  assert.equal(parseMp4(concatMp4([bytes, bytes])).tracks[0].sampleEntry, 'avc1');
});
