// Type declarations for mp4cat — lossless mp4 concatenation for Node and the browser.

/** One media sample as located in its source buffer. */
export interface Mp4Sample {
  /** absolute byte offset of the sample in the source file */
  offset: number;
  /** sample size in bytes */
  size: number;
  /** sample duration in track timescale ticks */
  dur: number;
  /** composition-time offset (ctts) in track timescale ticks; may be negative */
  cts: number;
  /** true when the sample is a sync sample (keyframe) */
  sync: boolean;
}

export interface Mp4Track {
  /** "video" | "audio" | raw handler 4cc for anything else */
  kind: string;
  /** track_id from tkhd */
  trackId: number;
  /** media timescale (ticks per second) */
  timescale: number;
  /** the whole stsd box, verbatim */
  stsdRaw: Uint8Array;
  /** first sample entry's 4cc, e.g. "avc1", "hvc1", "mp4a" */
  sampleEntry: string;
  /** codec configuration box bytes (avcC/hvcC/vpcC/av1C/esds/dOps/alac), or null if none found */
  codecCfg: Uint8Array | null;
  /** which codec configuration box was found, or null */
  codecCfgType: string | null;
  samples: Mp4Sample[];
  /** video only; 0 otherwise */
  width: number;
  height: number;
  /** audio only; 0 otherwise */
  channels: number;
  sampleRate: number;
}

export interface ParsedMp4 {
  tracks: Mp4Track[];
  /** true when the file carries moof fragments (fMP4/CMAF) */
  fragmented: boolean;
}

/** Parse one mp4 (progressive or fragmented) into its track/sample structure. Throws on non-mp4 input. */
export function parseMp4(u8: Uint8Array): ParsedMp4;

/** Quick sniff: does this buffer start with an mp4 ftyp box? */
export function isMp4(u8: Uint8Array): boolean;

export interface Mp4CompatResult {
  ok: boolean;
  /** null when ok; otherwise one sentence naming the first offending clip and what differs */
  reason: string | null;
}

/**
 * Strict compatibility gate over ≥2 mp4 buffers with a human-readable verdict.
 * opts.names labels clips in reasons (e.g. filenames) instead of "clip N".
 */
export function mp4Compat(bufs: Uint8Array[], opts?: { names?: string[] }): Mp4CompatResult;

/** Boolean form of mp4Compat, kept for back-compat. */
export function mp4ParamsMatch(bufs: Uint8Array[]): boolean;

export interface ConcatOptions {
  /**
   * Drop each later clip's first video sample — for clips authored as chained continuations
   * where clip N+1's first frame duplicates clip N's last frame. Default false.
   */
  dedup?: boolean;
}

/**
 * Losslessly concatenate whole-file mp4 buffers into one streamable mp4
 * (moov before mdat, samples interleaved). Call mp4Compat first — this does not re-check.
 */
export function concatMp4(buffers: Uint8Array[], opts?: ConcatOptions): Uint8Array;

export interface Mp4TrackInfo {
  kind: string;
  /** sample entry 4cc, e.g. "avc1" */
  codec: string;
  /** friendly name, e.g. "h264" ("mp4a" is reported as "aac") */
  codecName: string;
  /** track duration in seconds */
  duration: number;
  timescale: number;
  sampleCount: number;
  /** video only */
  width?: number;
  height?: number;
  fps?: number;
  /** audio only */
  channels?: number;
  sampleRate?: number;
}

export interface Mp4InfoResult {
  fragmented: boolean;
  /** longest track duration in seconds */
  duration: number;
  tracks: Mp4TrackInfo[];
}

/** Friendly probe: durations, codecs, dimensions, rates — no ffprobe needed. */
export function mp4Info(u8: Uint8Array): Mp4InfoResult;
