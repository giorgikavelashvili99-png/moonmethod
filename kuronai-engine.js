(function (root) {
  "use strict";

  const U32_MAX = 0xffffffff;
  const TECH_SAMPLE = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0]);
  const SIGNATURE = "****kryptonaep";

  class MP4Error extends Error {
    constructor(message, details = "") { super(message); this.name = "MP4Error"; this.details = details; }
  }

  const ascii = (bytes, offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const u16 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
  const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
  const i32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset);
  const u64 = (bytes, offset) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const value = Number(view.getBigUint64(offset));
    if (!Number.isSafeInteger(value)) throw new MP4Error("The file uses offsets beyond the browser's safe integer range.");
    return value;
  };

  function setU16(bytes, offset, value) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value); }
  function setU32(bytes, offset, value) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0); }
  function setI32(bytes, offset, value) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(offset, value); }
  function setU64(bytes, offset, value) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(offset, BigInt(value)); }

  function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const output = new Uint8Array(length);
    let cursor = 0;
    for (const part of parts) { output.set(part, cursor); cursor += part.byteLength; }
    return output;
  }

  function typeBytes(type) {
    if (type.length !== 4) throw new MP4Error(`Invalid FourCC: ${type}`);
    return Uint8Array.from([...type].map((char) => char.charCodeAt(0) & 255));
  }

  function makeBox(type, ...payloadParts) {
    const payloadSize = payloadParts.reduce((sum, part) => sum + part.byteLength, 0);
    const total = payloadSize + 8;
    if (total > U32_MAX) throw new MP4Error(`The ${type} atom is too large for browser mode.`);
    const header = new Uint8Array(8);
    setU32(header, 0, total);
    header.set(typeBytes(type), 4);
    return concat([header, ...payloadParts]);
  }

  function makeFullBox(type, version, flags, ...payloadParts) {
    const full = new Uint8Array(4);
    full[0] = version;
    full[1] = (flags >>> 16) & 255;
    full[2] = (flags >>> 8) & 255;
    full[3] = flags & 255;
    return makeBox(type, full, ...payloadParts);
  }

  function boxHeader(bytes, offset, limit = bytes.byteLength) {
    if (offset + 8 > limit) throw new MP4Error("Truncated MP4 atom.");
    let size = u32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > limit) throw new MP4Error("Truncated extended MP4 atom.");
      size = u64(bytes, offset + 8);
      headerSize = 16;
    } else if (size === 0) size = limit - offset;
    if (size < headerSize || offset + size > limit) throw new MP4Error(`Invalid ${type} atom size.`);
    return { type, start: offset, size, end: offset + size, headerSize };
  }

  function childBoxes(raw, contentOffset) {
    const parent = boxHeader(raw, 0);
    const boxes = [];
    let cursor = contentOffset ?? parent.headerSize;
    while (cursor < raw.byteLength) {
      const child = boxHeader(raw, cursor, raw.byteLength);
      boxes.push(child);
      cursor = child.end;
    }
    if (cursor !== raw.byteLength) throw new MP4Error(`Invalid alignment inside ${parent.type}.`);
    return boxes;
  }

  const rawChild = (raw, child) => raw.slice(child.start, child.end);
  function findChild(raw, type, contentOffset) { return childBoxes(raw, contentOffset).find((child) => child.type === type); }
  function requireChild(raw, type, contentOffset) {
    const child = findChild(raw, type, contentOffset);
    if (!child) throw new MP4Error(`Required atom is missing: ${type}.`);
    return rawChild(raw, child);
  }

  function rewriteContainer(raw, transform, contentOffset) {
    const header = boxHeader(raw, 0);
    const start = contentOffset ?? header.headerSize;
    const prefix = raw.slice(header.headerSize, start);
    const next = [];
    let ordinal = 0;
    for (const child of childBoxes(raw, start)) {
      const original = rawChild(raw, child);
      const replacement = transform(child.type, original, ordinal++);
      if (replacement) next.push(replacement);
    }
    return makeBox(header.type, prefix, ...next);
  }

  async function readTopLevel(file, progress) {
    const boxes = [];
    let cursor = 0;
    while (cursor < file.size) {
      const probe = new Uint8Array(await file.slice(cursor, Math.min(file.size, cursor + 16)).arrayBuffer());
      if (probe.byteLength < 8) throw new MP4Error("The file tail is not a recognized MP4 atom.");
      let size = u32(probe, 0);
      const type = ascii(probe, 4, 4);
      let headerSize = 8;
      if (size === 1) { if (probe.byteLength < 16) throw new MP4Error("Truncated extended header."); size = u64(probe, 8); headerSize = 16; }
      else if (size === 0) size = file.size - cursor;
      if (size < headerSize || cursor + size > file.size) {
        // Raw technical samples after mdat are intentionally not parsed as boxes.
        if (boxes.some((box) => box.type === "mdat")) break;
        throw new MP4Error(`Invalid top-level ${type} atom.`);
      }
      boxes.push({ type, start: cursor, size, end: cursor + size, headerSize });
      cursor += size;
      progress?.(Math.min(10, 2 + 8 * cursor / file.size));
    }
    const ftyp = boxes.find((box) => box.type === "ftyp");
    const moov = boxes.find((box) => box.type === "moov");
    const mdats = boxes.filter((box) => box.type === "mdat");
    if (!ftyp || !moov || mdats.length !== 1) throw new MP4Error("A flat MP4/MOV with exactly one mdat atom is required.", "ftyp, moov, and one mdat atom are mandatory");
    if (boxes.some((box) => box.type === "moof")) throw new MP4Error("Fragmented MP4 files are not supported by the lossless patch.");
    return {
      boxes, ftyp, moov, mdat: mdats[0],
      ftypRaw: new Uint8Array(await file.slice(ftyp.start, ftyp.end).arrayBuffer()),
      moovRaw: new Uint8Array(await file.slice(moov.start, moov.end).arrayBuffer())
    };
  }

  function parseMovieHeader(raw) {
    const header = boxHeader(raw, 0);
    const version = raw[header.headerSize];
    const base = header.headerSize + 4;
    if (version === 0) return { version, timescale: u32(raw, base + 8), duration: u32(raw, base + 12) };
    if (version === 1) return { version, timescale: u32(raw, base + 16), duration: u64(raw, base + 20) };
    throw new MP4Error("Unsupported mvhd version.");
  }

  function patchMovieHeader(raw, duration, nextTrackId) {
    const out = raw.slice();
    const header = boxHeader(out, 0);
    const version = out[header.headerSize];
    const base = header.headerSize + 4;
    if (version === 0) setU32(out, base + 12, duration);
    else setU64(out, base + 20, duration);
    setU32(out, out.byteLength - 4, nextTrackId);
    return out;
  }

  function parseTrackHeader(raw) {
    const header = boxHeader(raw, 0);
    const version = raw[header.headerSize];
    const base = header.headerSize + 4;
    if (version === 0) return { version, id: u32(raw, base + 8), duration: u32(raw, base + 16) };
    return { version, id: u32(raw, base + 16), duration: u64(raw, base + 28) };
  }

  function patchTrackHeader(raw, id, duration) {
    const out = raw.slice();
    const header = boxHeader(out, 0);
    const version = out[header.headerSize];
    const base = header.headerSize + 4;
    if (version === 0) { setU32(out, base + 8, id); setU32(out, base + 16, duration); }
    else { setU32(out, base + 16, id); setU64(out, base + 28, duration); }
    return out;
  }

  function parseMediaHeader(raw) {
    const header = boxHeader(raw, 0);
    const version = raw[header.headerSize];
    const base = header.headerSize + 4;
    if (version === 0) return { version, timescale: u32(raw, base + 8), duration: u32(raw, base + 12) };
    return { version, timescale: u32(raw, base + 16), duration: u64(raw, base + 20) };
  }

  function patchMediaHeader(raw, duration) {
    const out = raw.slice();
    const header = boxHeader(out, 0);
    const version = out[header.headerSize];
    const base = header.headerSize + 4;
    if (version === 0) setU32(out, base + 12, duration);
    else setU64(out, base + 20, duration);
    return out;
  }

  function handlerType(raw) {
    const header = boxHeader(raw, 0);
    return ascii(raw, header.headerSize + 8, 4);
  }

  function parseElst(raw) {
    if (!raw) return null;
    const header = boxHeader(raw, 0);
    const version = raw[header.headerSize];
    const count = u32(raw, header.headerSize + 4);
    if (!count) return null;
    const offset = header.headerSize + 8;
    if (version === 0) return { segmentDuration: u32(raw, offset), mediaTime: i32(raw, offset + 4) };
    const media = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigInt64(offset + 8);
    return { segmentDuration: u64(raw, offset), mediaTime: Number(media) };
  }

  function parseStts(raw) {
    const header = boxHeader(raw, 0);
    const count = u32(raw, header.headerSize + 4);
    const entries = [];
    let cursor = header.headerSize + 8;
    let sampleCount = 0;
    for (let i = 0; i < count; i++, cursor += 8) {
      const run = { count: u32(raw, cursor), duration: u32(raw, cursor + 4) };
      entries.push(run); sampleCount += run.count;
    }
    return { entries, sampleCount };
  }

  function expandDurations(stts) {
    const output = new Uint32Array(stts.sampleCount);
    let cursor = 0;
    for (const entry of stts.entries) { output.fill(entry.duration, cursor, cursor + entry.count); cursor += entry.count; }
    return output;
  }

  function runsFromDurations(durations) {
    const entries = [];
    for (let i = 0; i < durations.length; i++) {
      const duration = durations[i];
      const last = entries[entries.length - 1];
      if (last && last.duration === duration) last.count++;
      else entries.push({ count: 1, duration });
    }
    return entries;
  }

  function makeStts(entries) {
    const payload = new Uint8Array(4 + entries.length * 8);
    setU32(payload, 0, entries.length);
    entries.forEach((entry, index) => { setU32(payload, 4 + index * 8, entry.count); setU32(payload, 8 + index * 8, entry.duration); });
    return makeFullBox("stts", 0, 0, payload);
  }

  function parseStsz(raw) {
    const header = boxHeader(raw, 0);
    const fixed = u32(raw, header.headerSize + 4);
    const count = u32(raw, header.headerSize + 8);
    const sizes = new Uint32Array(count);
    if (fixed) sizes.fill(fixed);
    else for (let i = 0; i < count; i++) sizes[i] = u32(raw, header.headerSize + 12 + i * 4);
    return sizes;
  }

  function makeStsz(sizes, dummyCount = 0) {
    const total = sizes.length + dummyCount;
    const payload = new Uint8Array(8 + total * 4);
    setU32(payload, 0, 0); setU32(payload, 4, total);
    for (let i = 0; i < sizes.length; i++) setU32(payload, 8 + i * 4, sizes[i]);
    for (let i = sizes.length; i < total; i++) setU32(payload, 8 + i * 4, 8);
    return makeFullBox("stsz", 0, 0, payload);
  }

  function parseStsc(raw) {
    const header = boxHeader(raw, 0);
    const count = u32(raw, header.headerSize + 4);
    const entries = [];
    for (let i = 0; i < count; i++) {
      const cursor = header.headerSize + 8 + i * 12;
      entries.push({ firstChunk: u32(raw, cursor), samplesPerChunk: u32(raw, cursor + 4), description: u32(raw, cursor + 8) });
    }
    return entries;
  }

  function makeStsc(chunkSampleCounts) {
    const entries = [];
    chunkSampleCounts.forEach((count, index) => {
      if (!index || chunkSampleCounts[index - 1] !== count) entries.push({ firstChunk: index + 1, samplesPerChunk: count, description: 1 });
    });
    const payload = new Uint8Array(4 + entries.length * 12);
    setU32(payload, 0, entries.length);
    entries.forEach((entry, index) => {
      const cursor = 4 + index * 12;
      setU32(payload, cursor, entry.firstChunk); setU32(payload, cursor + 4, entry.samplesPerChunk); setU32(payload, cursor + 8, entry.description);
    });
    return makeFullBox("stsc", 0, 0, payload);
  }

  function parseChunkOffsets(raw) {
    const header = boxHeader(raw, 0);
    const count = u32(raw, header.headerSize + 4);
    const offsets = new Array(count);
    const wide = header.type === "co64";
    for (let i = 0; i < count; i++) offsets[i] = wide ? u64(raw, header.headerSize + 8 + i * 8) : u32(raw, header.headerSize + 8 + i * 4);
    return offsets;
  }

  function makeChunkOffsets(offsets, wide) {
    const payload = new Uint8Array(4 + offsets.length * (wide ? 8 : 4));
    setU32(payload, 0, offsets.length);
    offsets.forEach((offset, index) => wide ? setU64(payload, 4 + index * 8, offset) : setU32(payload, 4 + index * 4, offset));
    return makeFullBox(wide ? "co64" : "stco", 0, 0, payload);
  }

  function sampleOffsets(sizes, chunkOffsets, stsc) {
    const offsets = new Array(sizes.length);
    let sample = 0;
    for (let chunk = 0; chunk < chunkOffsets.length; chunk++) {
      let entryIndex = 0;
      while (entryIndex + 1 < stsc.length && stsc[entryIndex + 1].firstChunk <= chunk + 1) entryIndex++;
      const samplesInChunk = stsc[entryIndex].samplesPerChunk;
      let cursor = chunkOffsets[chunk];
      for (let i = 0; i < samplesInChunk && sample < sizes.length; i++, sample++) { offsets[sample] = cursor; cursor += sizes[sample]; }
    }
    if (sample !== sizes.length || offsets.some((value) => value === undefined)) throw new MP4Error("The stsc/stco/stsz tables do not describe every sample.");
    return offsets;
  }

  function stsdCodec(stsd) {
    const header = boxHeader(stsd, 0);
    const firstEntry = header.headerSize + 8;
    if (firstEntry + 8 > stsd.byteLength) return "";
    return ascii(stsd, firstEntry + 4, 4);
  }

  function totalDuration(durations) { let sum = 0; for (const value of durations) sum += value; return sum; }

  function parseTrack(trakRaw, movieTimescale) {
    const tkhd = requireChild(trakRaw, "tkhd");
    const mdia = requireChild(trakRaw, "mdia");
    const mdhd = requireChild(mdia, "mdhd");
    const hdlr = requireChild(mdia, "hdlr");
    const minf = requireChild(mdia, "minf");
    const stbl = requireChild(minf, "stbl");
    const stsd = requireChild(stbl, "stsd");
    const sttsRaw = requireChild(stbl, "stts");
    const stszRaw = requireChild(stbl, "stsz");
    const stscRaw = requireChild(stbl, "stsc");
    const offsetRaw = findChild(stbl, "stco") ? requireChild(stbl, "stco") : requireChild(stbl, "co64");
    const sizes = parseStsz(stszRaw);
    const stts = parseStts(sttsRaw);
    if (sizes.length !== stts.sampleCount) throw new MP4Error("The stsz and stts sample counts do not match.");
    const mdhdInfo = parseMediaHeader(mdhd);
    const tkhdInfo = parseTrackHeader(tkhd);
    const edtsBox = findChild(trakRaw, "edts");
    const edts = edtsBox ? rawChild(trakRaw, edtsBox) : null;
    const elst = edts && findChild(edts, "elst") ? parseElst(requireChild(edts, "elst")) : null;
    const durations = expandDurations(stts);
    const handler = handlerType(hdlr);
    const codec = stsdCodec(stsd);

    if (durations.length && durations[durations.length - 1] === 0) {
      let previous = 1;
      for (let i = durations.length - 2; i >= 0; i--) if (durations[i]) { previous = durations[i]; break; }
      durations[durations.length - 1] = previous;
    }
    if (handler === "soun" && elst && elst.mediaTime > 0 && durations.length) {
      const desired = elst.mediaTime + Math.round(elst.segmentDuration * mdhdInfo.timescale / movieTimescale);
      const beforeLast = totalDuration(durations.subarray(0, durations.length - 1));
      const last = desired - beforeLast;
      if (last > 0 && last <= U32_MAX) durations[durations.length - 1] = last;
    }

    const chunks = parseChunkOffsets(offsetRaw);
    return {
      raw: trakRaw, tkhd, mdia, mdhd, minf, stbl, stsd,
      id: tkhdInfo.id, handler, codec, timescale: mdhdInfo.timescale,
      sizes, durations, inputOffsets: sampleOffsets(sizes, chunks, parseStsc(stscRaw)),
      edit: elst, outputChunkRel: [], outputChunkSamples: [], outputSampleRel: handler === "soun" ? new Array(sizes.length) : null,
      mediaDuration: totalDuration(durations), presentationDuration: elst?.segmentDuration > 0 ? elst.segmentDuration : 0
    };
  }

  function sanitizeSignatureBytes(bytes) {
    const out = bytes.slice();
    let changes = 0;
    const patterns = ["lavc", "lavf", "x264", "x265", "handbrake", "compressbase", "itzcrih", "adobe media encoder"];
    let start = 0;
    while (start < out.length) {
      while (start < out.length && (out[start] < 32 || out[start] > 126)) start++;
      let end = start;
      while (end < out.length && out[end] >= 32 && out[end] <= 126) end++;
      if (end - start >= 4) {
        const text = ascii(out, start, end - start).toLowerCase();
        if (patterns.some((pattern) => text.includes(pattern))) { out.fill(42, start, end); changes++; }
      }
      start = Math.max(end, start + 1);
    }
    return { bytes: out, changes };
  }

  function chooseNext(states, tracks) {
    let selected = -1;
    let selectedTime = Infinity;
    for (let i = 0; i < states.length; i++) {
      if (states[i].sample >= tracks[i].sizes.length) continue;
      const time = states[i].dts / tracks[i].timescale;
      if (time < selectedTime - 1e-12) { selected = i; selectedTime = time; continue; }
      if (Math.abs(time - selectedTime) <= 1e-12) {
        const rank = tracks[i].handler === "soun" ? 0 : tracks[i].handler === "vide" ? 1 : 2;
        const selectedRank = tracks[selected].handler === "soun" ? 0 : tracks[selected].handler === "vide" ? 1 : 2;
        if (rank < selectedRank || (rank === selectedRank && i < selected)) selected = i;
      }
    }
    return selected;
  }

  function buildInterleavePlan(tracks, progress) {
    const states = tracks.map(() => ({ sample: 0, dts: 0 }));
    const totalSamples = tracks.reduce((sum, track) => sum + track.sizes.length, 0);
    const segments = [];
    let processed = 0;
    let payloadSize = 0;
    let previousTrack = -1;
    while (processed < totalSamples) {
      const trackIndex = chooseNext(states, tracks);
      if (trackIndex < 0) throw new MP4Error("The media samples could not be ordered.");
      const track = tracks[trackIndex];
      const state = states[trackIndex];
      const sample = state.sample;
      const size = track.sizes[sample];
      const sourceOffset = track.inputOffsets[sample];
      if (trackIndex !== previousTrack) {
        track.outputChunkRel.push(payloadSize);
        track.outputChunkSamples.push(1);
      } else track.outputChunkSamples[track.outputChunkSamples.length - 1]++;
      if (track.outputSampleRel) track.outputSampleRel[sample] = payloadSize;

      // Encoder strings such as Lavc can recur periodically in AAC fill elements.
      // Scan every audio packet (small) and only the first packet of other tracks.
      const sanitize = track.handler === "soun" || sample === 0;
      const previous = segments[segments.length - 1];
      if (!sanitize && previous && !previous.sanitize && previous.sourceOffset + previous.size === sourceOffset) previous.size += size;
      else segments.push({ sourceOffset, size, sanitize });

      payloadSize += size;
      state.dts += track.durations[sample];
      state.sample++;
      processed++;
      previousTrack = trackIndex;
      if (!(processed % 5000)) progress?.(20 + 28 * processed / totalSamples, `Reinterleaving ${processed.toLocaleString("en-US")} / ${totalSamples.toLocaleString("en-US")}`);
    }
    return { segments, payloadSize };
  }

  function makeDataBox(text) {
    const encoded = new TextEncoder().encode(text);
    const prefix = new Uint8Array(8);
    setU32(prefix, 0, 1); setU32(prefix, 4, 0);
    return makeBox("data", prefix, encoded);
  }

  function makeMetadata() {
    const hdlrPayload = new Uint8Array(25);
    hdlrPayload.set(typeBytes("mdir"), 8);
    hdlrPayload[24] = 0;
    const hdlr = makeFullBox("hdlr", 0, 0, hdlrPayload);
    const ilst = makeBox("ilst",
      makeBox(String.fromCharCode(0xa9) + "too", makeDataBox(SIGNATURE)),
      makeBox(String.fromCharCode(0xa9) + "cmt", makeDataBox(`Processed by ${SIGNATURE}`))
    );
    return makeBox("udta", makeFullBox("meta", 0, 0, hdlr, ilst));
  }

  function rewriteTrack(track, tables, id, tkhdDuration, mdhdDuration) {
    const newStbl = rewriteContainer(track.stbl, (type, raw) => {
      if (type === "stts") return tables.stts;
      if (type === "stsc") return tables.stsc;
      if (type === "stsz") return tables.stsz;
      if (type === "stco" || type === "co64") return type === tables.offsetType ? tables.offsets : (type === "stco" && tables.offsetType === "co64" ? tables.offsets : null);
      return raw;
    });
    // If the source lacked the selected offset type, the rewrite above replaces its existing counterpart.
    const newMinf = rewriteContainer(track.minf, (type, raw) => type === "stbl" ? newStbl : raw);
    const newMdia = rewriteContainer(track.mdia, (type, raw) => {
      if (type === "mdhd") return patchMediaHeader(raw, mdhdDuration);
      if (type === "minf") return newMinf;
      return raw;
    });
    return rewriteContainer(track.raw, (type, raw) => {
      if (type === "tkhd") return patchTrackHeader(raw, id, tkhdDuration);
      if (type === "edts") return null;
      if (type === "mdia") return newMdia;
      return raw;
    });
  }

  function buildTables(track, absoluteBase, wide) {
    const offsets = track.outputChunkRel.map((offset) => absoluteBase + offset);
    return {
      stts: makeStts(runsFromDurations(track.durations)),
      stsc: makeStsc(track.outputChunkSamples),
      stsz: makeStsz(track.sizes),
      offsets: makeChunkOffsets(offsets, wide), offsetType: wide ? "co64" : "stco"
    };
  }

  function buildCloneTables(track, absoluteBase, dummyStart, dummyCount, wide) {
    const offsets = track.outputSampleRel.map((offset) => absoluteBase + offset);
    offsets.push(dummyStart);
    const entries = runsFromDurations(track.durations);
    if (dummyCount) entries.push({ count: dummyCount, duration: 1 });
    return {
      stts: makeStts(entries),
      stsc: makeStsc([...new Array(track.sizes.length).fill(1), dummyCount]),
      stsz: makeStsz(track.sizes, dummyCount),
      offsets: makeChunkOffsets(offsets, wide), offsetType: wide ? "co64" : "stco"
    };
  }

  function buildMoov(moovRaw, mvhdRaw, movieInfo, tracks, sourceAudioIndex, dummyCount, layout, wide) {
    const maxId = Math.max(...tracks.map((track) => track.id));
    const cloneId = maxId + 1;
    const trackBoxes = tracks.map((track) => {
      const duration = track.presentationDuration || Math.round(track.mediaDuration * movieInfo.timescale / track.timescale);
      const tables = buildTables(track, layout.mediaBase, wide);
      return rewriteTrack(track, tables, track.id, duration, track.mediaDuration);
    });
    const source = tracks[sourceAudioIndex];
    const sourceDuration = source.presentationDuration || Math.round(source.mediaDuration * movieInfo.timescale / source.timescale);
    const cloneTables = buildCloneTables(source, layout.mediaBase, layout.dummyStart, dummyCount, wide);
    const clone = rewriteTrack(source, cloneTables, cloneId, sourceDuration, source.mediaDuration + dummyCount);
    const presentationDurations = tracks.map((track) => track.presentationDuration || Math.round(track.mediaDuration * movieInfo.timescale / track.timescale));
    const movieDuration = Math.max(...presentationDurations);
    const mvhd = patchMovieHeader(mvhdRaw, movieDuration, cloneId + 1);
    let trackCursor = 0;
    const children = [];
    for (const child of childBoxes(moovRaw)) {
      const raw = rawChild(moovRaw, child);
      if (child.type === "mvhd") children.push(mvhd);
      else if (child.type === "trak") children.push(trackBoxes[trackCursor++]);
      else if (child.type !== "udta") children.push(raw);
    }
    children.push(clone, makeMetadata());
    return makeBox("moov", ...children);
  }

  function mdatHeader(payloadSize) {
    const total = payloadSize + 8;
    if (total <= U32_MAX) {
      const header = new Uint8Array(8); setU32(header, 0, total); header.set(typeBytes("mdat"), 4); return header;
    }
    const header = new Uint8Array(16); setU32(header, 0, 1); header.set(typeBytes("mdat"), 4); setU64(header, 8, payloadSize + 16); return header;
  }

  function dummyParts(count) {
    const parts = [];
    const samplesPerPart = 131072;
    while (count > 0) {
      const samples = Math.min(count, samplesPerPart);
      const bytes = new Uint8Array(samples * 8);
      for (let cursor = 0; cursor < bytes.length; cursor += 8) bytes.set(TECH_SAMPLE, cursor);
      parts.push(bytes); count -= samples;
    }
    return parts;
  }

  async function materializeSegments(file, segments, progress) {
    const parts = [];
    let signatureChanges = 0;
    const fileData = new Uint8Array(await file.arrayBuffer());
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segBytes = fileData.subarray(segment.sourceOffset, segment.sourceOffset + segment.size);
      if (segment.sanitize) {
        const sanitized = sanitizeSignatureBytes(segBytes);
        signatureChanges += sanitized.changes;
        parts.push(sanitized.bytes);
      } else parts.push(segBytes.slice());
      if (!(i % 5000)) progress?.(66 + 22 * i / Math.max(1, segments.length), `Assembling ${i.toLocaleString("en-US")} / ${segments.length.toLocaleString("en-US")} blocks`);
    }
    return { parts, signatureChanges };
  }

  async function process(file, progress = () => {}) {
    if (!file || !Number.isFinite(file.size) || file.size < 32) throw new MP4Error("Select a valid video file.");
    progress(2, "Container analysis", "Scanning top-level atoms");
    const top = await readTopLevel(file, (value) => progress(value, "Container analysis", "Scanning top-level atoms"));
    const moovChildren = childBoxes(top.moovRaw);
    const mvhdChild = moovChildren.find((child) => child.type === "mvhd");
    if (!mvhdChild) throw new MP4Error("The mvhd atom is missing.");
    const mvhdRaw = rawChild(top.moovRaw, mvhdChild);
    const movieInfo = parseMovieHeader(mvhdRaw);
    if (!movieInfo.timescale) throw new MP4Error("Invalid movie timescale.");
    if (moovChildren.some((child) => child.type === "mvex")) throw new MP4Error("This is a fragmented MP4; the sample-level patch requires a flat MP4.");

    progress(12, "Track indexing", "Reading sample sizes, DTS, chunks, and offsets");
    const tracks = moovChildren.filter((child) => child.type === "trak").map((child) => parseTrack(rawChild(top.moovRaw, child), movieInfo.timescale));
    if (!tracks.length) throw new MP4Error("No media tracks were found.");
    const sourceAudioIndex = tracks.findIndex((track) => track.handler === "soun" && track.codec === "mp4a");
    if (sourceAudioIndex < 0) throw new MP4Error("At least one AAC/mp4a track is required to reproduce the detected patch.", "The video was not transcoded automatically because that would change the signal");
    if (tracks.some((track) => ["encv", "enca"].includes(track.codec))) throw new MP4Error("Encrypted or DRM-protected tracks cannot be rewritten.");
    const source = tracks[sourceAudioIndex];
    if (!source.sizes.length) throw new MP4Error("The AAC track is empty.");
    if (source.sizes.length > Math.floor(U32_MAX / 10)) throw new MP4Error("There are too many samples for 32-bit MP4 tables.");
    const dummyCount = source.sizes.length * 9;

    progress(20, "Lossless reinterleaving", "Ordering packets by DTS");
    const plan = buildInterleavePlan(tracks, (value, detail) => progress(value, "Lossless reinterleaving", detail));
    const header = mdatHeader(plan.payloadSize);
    const estimatedSize = top.ftypRaw.byteLength + top.moovRaw.byteLength * 12 + header.byteLength + plan.payloadSize + dummyCount * 8;
    let wide = estimatedSize > U32_MAX;

    progress(50, "Rebuilding moov", "Creating new sample tables");
    let placeholder = { mediaBase: 0, dummyStart: 0 };
    let moov = buildMoov(top.moovRaw, mvhdRaw, movieInfo, tracks, sourceAudioIndex, dummyCount, placeholder, wide);
    let mediaBase = top.ftypRaw.byteLength + moov.byteLength + header.byteLength;
    let dummyStart = mediaBase + plan.payloadSize;
    if (!wide && dummyStart + dummyCount * 8 > U32_MAX) {
      wide = true;
      moov = buildMoov(top.moovRaw, mvhdRaw, movieInfo, tracks, sourceAudioIndex, dummyCount, placeholder, true);
      mediaBase = top.ftypRaw.byteLength + moov.byteLength + header.byteLength;
      dummyStart = mediaBase + plan.payloadSize;
    }
    moov = buildMoov(top.moovRaw, mvhdRaw, movieInfo, tracks, sourceAudioIndex, dummyCount, { mediaBase, dummyStart }, wide);
    // A co64 rebuild can alter moov size; converge once with the actual size.
    const correctedBase = top.ftypRaw.byteLength + moov.byteLength + header.byteLength;
    if (correctedBase !== mediaBase) {
      mediaBase = correctedBase; dummyStart = mediaBase + plan.payloadSize;
      moov = buildMoov(top.moovRaw, mvhdRaw, movieInfo, tracks, sourceAudioIndex, dummyCount, { mediaBase, dummyStart }, wide);
    }

    progress(66, "Sanitization", "Removing identifying signatures without changing sample sizes");
    const media = await materializeSegments(file, plan.segments, progress);
    const tail = dummyParts(dummyCount);
    const blob = new Blob([top.ftypRaw, moov, header, ...media.parts, ...tail], { type: "video/mp4" });
    progress(96, "Internal verification", "Checking sizes, offsets, and sample counts");
    const expected = top.ftypRaw.byteLength + moov.byteLength + header.byteLength + plan.payloadSize + dummyCount * 8;
    if (blob.size !== expected) throw new MP4Error("The final size does not match the atom layout plan.");
    return {
      blob,
      report: {
        container: `${ascii(top.ftypRaw, 8, 4)} / ISO-BMFF`, inputTracks: tracks.length, outputTracks: tracks.length + 1,
        sourceAudio: `track ${source.id} · ${source.codec} · ${source.timescale} Hz`, sourceSamples: source.sizes.length,
        dummySamples: dummyCount, mediaPayloadPreserved: media.signatureChanges === 0,
        sanitizedSignatures: media.signatureChanges, offsetMode: wide ? "co64 (64 bit)" : "stco (32 bit)",
        movieTimescale: movieInfo.timescale, movieDuration: Math.max(...tracks.map((track) => track.presentationDuration || Math.round(track.mediaDuration * movieInfo.timescale / track.timescale))),
        outputBytes: blob.size, mediaBytes: plan.payloadSize, dummyBytes: dummyCount * 8
      }
    };
  }

  const api = { process, MP4Error, _internals: { childBoxes, parseTrack, buildInterleavePlan, sanitizeSignatureBytes } };
  root.KryptonaepMP4 = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
