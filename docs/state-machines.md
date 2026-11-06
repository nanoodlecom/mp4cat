# State-machine audit — 2026-11-06

Audited baseline: `3111b88bbbc40b0f50b0bca8c106b38da27842b3`.
Scope: all runtime source (`src/index.mjs`, declarations, CLI), tests, package
metadata, and the only workflow. This is a synchronous in-memory library plus a
one-shot Node CLI. There is no server, database, background worker, distributed
lock, persistent job, authentication flow, scheduler, network client, or retry
queue in this repository.

## Inventory

| Machine / state | Transitions and invariants | Outcome |
| --- | --- | --- |
| Box cursor `(position, parent end, header size)` | 32-bit / extended / to-end header → bounded payload → next sibling; incomplete input must throw, never silently finish parsing | Fixed truncated headers, undersized extended headers, unsafe lengths, and parent-boundary escape; sample-entry identity survives extended stsd headers |
| Track discovery `(handler, track ID, metadata)` | trak → mdia → handler → timescale → description; broken tracks cannot disappear from the gate | Required bounded metadata, positive timescale, unique nonzero track IDs, explicit rejection of unsupported non-media tracks |
| Progressive sizes `(count, default size, index)` | Constant or per-sample size → allocated table → exactly count samples | Bound counts before allocation and field reads; zero-size samples rejected |
| Timing runs `(run, remaining samples, DTS, CTS version)` | stts / ctts runs expand exactly; v0 CTS unsigned, v1 signed; durations positive | Fixed invented durations, truncated or excess run coverage, and signed interpretation of v0 CTS |
| Sync samples `(last 1-based index, set / absent)` | Absent stss means all sync; explicit empty means none; ordered indexes within sample count | Invalid indexes rejected; explicit empty writer behavior retained |
| Chunk reconstruction `(chunk, stsc run, sample index, offset)` | Strictly ordered runs beginning at chunk 1; description index 1; consume each sample once | Missing/invalid runs, excess samples, conflicting stco/co64, and unsupported description changes rejected |
| Fragment defaults `(trex → tfhd → trun)` | Movie defaults overridden by track then sample fields; one supported description; first-sample flags versus per-sample flags | Bounds/version checks, unsupported transitions and unknown track references rejected |
| Fragment byte cursor `(base, position, previous traf end)` | Explicit absolute base / moof base / implicit carry; signed trun relative offset; omitted offset continues previous run | Sample must reside wholly in an mdat payload; negative and unsafe offsets rejected; positive base modes and multiple-run continuation tested |
| Fragment decode cursor `(track ID, next DTS)` | First tfdt establishes origin; following tfdt must equal accumulated durations; omitted tfdt continues | Fixed silent collapse of gaps/overlaps, including reordered or replayed nonempty fragments with timestamps; unsafe 64-bit precision rejected |
| Compatibility gate `(parsed clips, shape, decoder signatures)` | Parse → shape → video config / audio config → accept or named failure | Fixed dropped extra tracks and acceptance of equally missing/damaged audio descriptors; encrypted sample entries rejected; ALAC signature preserves decoder fields while ignoring known bitrate statistics |
| Concat timeline `(clip, track, output timescale, dedup)` | Match corresponding tracks, optionally drop later first video sample, rescale → merged samples | Explicit empty-input error; zero/overflow rescaled durations and unrepresentable composition offsets rejected |
| Interleaver `(track cursors, next DTS)` | Select earliest finite DTS; consume ≥1 sample per chunk; stop when all consumed | Positive parsed timescales/durations prevent NaN state from silently dropping samples |
| Writer `(chunks, offsets, first moov size, final moov size)` | Size pass → relocated offsets → final moov → payload copy | Existing 4-GiB and moov-size checks retained; reject movie-duration wrap and mixed CTS values that cannot share one signed table |
| CLI argument mode `(info / concat, options, paths)` | Parse flags → reject incompatible modes → read → inspect or gate → concat → emit | Existing ignored-flag, stdin, help/version handling retained |
| CLI file publication `(read, computed, staging, published, cleanup)` | All inputs read before writing; write in private sibling directory; rename complete output; clean up on failure/success | Replaced destructive direct truncation with atomic rename; injected partial-write failure leaves old output untouched; regular-file target, mode and symlink behavior tested |
| CLI streams `(queued stdout, drained / EPIPE / error)` | Natural process drain; downstream EPIPE exits normally; other errors fail | Existing behavior retained; stdout cannot be transactional |
| CI/release `(branch, draft PR, checks, merge, package release)` | GitHub push/PR runs tests on three patched Node versions; no publish/deploy workflow | Merge changes source only. npm `0.2.0` publication is separate and is not triggered by merging |

## Reproductions and fixes

The initial structural regression run against the baseline produced 9 failing
regression groups (1 passing positive-control group): zero timing, invalid media
offsets, sample-count disagreement, description transitions, discontinuous fragment
timelines, unsigned composition offsets, silently discarded non-media tracks,
truncated tables, and output timing bounds. Later coverage adds malformed audio
signatures and injected partial file-write failure.

`tests/state-machines.test.mjs` constructs small structural fixtures without
FFmpeg, exercises those transitions, and verifies progressive/fragmented
round-trips. It also verifies three fragment base modes and implicit continuation
between truns. The atomic-output test injects a partial `writeFile` failure in a
separate CLI process, then checks unchanged old content and removed staging
files. Existing `tests/mp4cat.test.mjs` generates real H.264/AAC fixtures and
fully decodes progressive, fragmented, and audio-only concatenations with FFmpeg.

## Deliberate limits and recovery semantics

- Whole inputs and output remain in memory. Arbitrary huge inputs can exhaust
  memory; this is not a streaming parser or an isolation boundary for hostile
  uploads. Counts are bounded by supplied bytes, not a new global resource quota.
- `concatMp4` retains its documented caller contract: call `mp4Compat` first for
  codec and track-shape checks. It does independently reject malformed parsing
  and output timing. A gate success does not promise every timescale conversion
  is representable.
- Edit lists, rotation matrices, sample groups and other ancillary metadata are
  not preserved. Initial fragment decode origins are normalized per track;
  distinct initial A/V origins may lose relative alignment. Supporting those
  features requires an expanded muxer contract. Dedup can remove a required
  keyframe and does not trim audio; these pre-existing documented limits remain.
- Audio descriptors are compared structurally; codec bitstreams are not decoded
  by this library. AAC/H.264 are the integration-tested path. Encrypted input
  and multiple descriptions are not supported.
- Concurrent CLI writers have last-successful-rename semantics. Readers observe
  a complete old or new file on filesystems with atomic same-directory rename.
  This is atomic publication, not fsync-based power-loss durability. A process
  killed before rename leaves the destination intact but may leave its staging
  directory. Cleanup failure after successful publication does not undo it.
- Stdout errors may occur after a prefix reached the receiver; the receiver owns
  stream recovery. There are no automatic retries or replay side effects.
- There were no open PRs or deployment records at audit start. The latest release
  was `v0.2.0`, published 2026-07-17, with no release assets. The existing main CI
  failure was FFmpeg setup on Node 26, before tests; two other matrix jobs passed.
  No credential or permission changes, live data mutations, npm publication,
  external service deployment, or unrelated repository edits are part of this fix.

## Local verification

- Node `22.23.4`: 35/35 tests passed before the final encrypted-entry guard.
- Node `24.22.1`: 36/36 tests passed, 0 skipped, with FFmpeg/ffprobe 7.0.2.
  The exact final head is also checked by the PR matrix
  (22.23.4 / 24.22.1 / 26.12.1).
- `git diff --check` passed; `npm pack --dry-run` contained only the expected six
  package files. No tarball was published and the package version stays `0.2.0`.
