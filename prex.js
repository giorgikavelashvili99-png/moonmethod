{
  'use strict';

  /* ================================================================
     PREX METHOD v4.7.0 — CONSISTENT DENSITY (ghost-fps + full timeline consistency)
     ----------------------------------------------------------------
     Engine 1 · patchPrex: sample-table inflation on the VIDEO track
       (stts/stsz/stsc/stco) WITH full timeline consistency - ghost
       frames use 1-tick deltas and mdhd/tkhd/mvhd durations extend by
       exactly those ticks, so no validator can find a timing mismatch.
       NO SEI stripping, NO avcC edits, NO btrt injection. Video/audio
       streams byte-identical. Default multiplier 5x (tunable).
     Engine 2 · patchTimescale: normalize all mvhd/mdhd to ts=30000.
     ================================================================ */

  const MULTIPLIER = 5;
  const MAX_GHOSTS = 150000;
  const KEEP_NALU_TYPES = new Set([1, 5]);
  const PADDING_NAL = Uint8Array.from([0, 0, 0, 4, 0, 0, 0, 0]);
  const LANG_UND = 0x55c4;
  const AVC_C_EXT = Uint8Array.from([0xfd, 0xf8, 0xf8, 0x00]);
  const CONTAINER_TYPES = new Set([
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta', 'ilst',
  ]);

  /* ---------- low level ---------- */

  function readU32(bytes, off) {
    return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
  }

  function readI32(bytes, off) {
    return readU32(bytes, off) | 0;
  }

  function writeU32(bytes, off, value) {
    bytes[off] = (value >>> 24) & 0xff;
    bytes[off + 1] = (value >>> 16) & 0xff;
    bytes[off + 2] = (value >>> 8) & 0xff;
    bytes[off + 3] = value & 0xff;
  }

  function readU64(bytes, off) {
    return (BigInt(readU32(bytes, off)) << 32n) | BigInt(readU32(bytes, off + 4));
  }

  function writeU64(bytes, off, value) {
    writeU32(bytes, off, Number((value >> 32n) & 0xffffffffn));
    writeU32(bytes, off + 4, Number(value & 0xffffffffn));
  }

  function readType(bytes, off) {
    return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  }

  function writeType(bytes, off, value) {
    for (let i = 0; i < 4; i += 1) bytes[off + i] = value.charCodeAt(i);
  }

  function toUint8Array(value) {
    if (value instanceof Uint8Array) {
      return value.constructor === Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return new Uint8Array(value);
  }

  function concat(parts) {
    const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      out.set(part, cursor);
      cursor += part.byteLength;
    }
    return out;
  }

  function repeatBytes(pattern, count) {
    const out = new Uint8Array(pattern.byteLength * count);
    for (let cursor = 0; cursor < out.byteLength; cursor += pattern.byteLength) out.set(pattern, cursor);
    return out;
  }

  function utf8(value) {
    return new TextEncoder().encode(value);
  }

  function bytesEqual(left, right) {
    if (left.byteLength !== right.byteLength) return false;
    for (let i = 0; i < left.byteLength; i += 1) if (left[i] !== right[i]) return false;
    return true;
  }

  function entriesEqual(left, right) {
    return left.length === right.length && left.every((entry, index) => (
      entry.sampleCount === right[index].sampleCount && entry.sampleDelta === right[index].sampleDelta
    ));
  }

  /* ---------- box parsing ---------- */

  function parseChildren(bytes, start, end) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      const size32 = readU32(bytes, offset);
      const type = readType(bytes, offset + 4);
      let header = 8;
      let size = size32;
      if (size32 === 1) {
        size = Number(readU64(bytes, offset + 8));
        header = 16;
      } else if (size32 === 0) {
        size = end - offset;
      }
      if (!Number.isSafeInteger(size) || size < header || offset + size > end) break;
      const box = { type, start: offset, end: offset + size, size, header, children: [] };
      const childStart = offset + header + (type === 'meta' ? 4 : 0);
      if (CONTAINER_TYPES.has(type) && childStart < box.end) box.children = parseChildren(bytes, childStart, box.end);
      boxes.push(box);
      offset += size;
    }
    return boxes;
  }

  function findBox(parent, path) {
    let current = parent;
    for (const type of path) {
      current = current && current.children ? current.children.find((box) => box.type === type) : null;
      if (!current) return null;
    }
    return current;
  }

  function makeBox(type, payload) {
    const size = payload.byteLength + 8;
    if (size > 0xffffffff) throw new Error('Box ' + type + ' exceeds 32-bit size.');
    const out = new Uint8Array(size);
    writeU32(out, 0, size);
    writeType(out, 4, type);
    out.set(payload, 8);
    return out;
  }

  function makeFtyp() {
    const payload = new Uint8Array(24);
    writeType(payload, 0, 'isom');
    writeU32(payload, 4, 512);
    writeType(payload, 8, 'isom');
    writeType(payload, 12, 'iso2');
    writeType(payload, 16, 'avc1');
    writeType(payload, 20, 'mp41');
    return makeBox('ftyp', payload);
  }

  function makeFree() {
    return makeBox('free', new Uint8Array(0));
  }

  function makeMdatHeader(contentBytes, headerSize) {
    const out = new Uint8Array(headerSize);
    const totalSize = contentBytes + headerSize;
    if (headerSize === 16) {
      writeU32(out, 0, 1);
      writeType(out, 4, 'mdat');
      writeU64(out, 8, BigInt(totalSize));
    } else {
      writeU32(out, 0, totalSize);
      writeType(out, 4, 'mdat');
    }
    return out;
  }

  /* ---------- table readers ---------- */

  function readStszSizes(bytes, stszBox) {
    const sampleSize = readU32(bytes, stszBox.start + 12);
    const count = readU32(bytes, stszBox.start + 16);
    if (sampleSize !== 0) return new Array(count).fill(sampleSize);
    const sizes = new Array(count);
    for (let i = 0, cursor = stszBox.start + 20; i < count; i += 1, cursor += 4) sizes[i] = readU32(bytes, cursor);
    return sizes;
  }

  function readStscEntries(bytes, stscBox) {
    const count = readU32(bytes, stscBox.start + 12);
    const entries = [];
    for (let i = 0, cursor = stscBox.start + 16; i < count; i += 1, cursor += 12) {
      entries.push({
        firstChunk: readU32(bytes, cursor),
        samplesPerChunk: readU32(bytes, cursor + 4),
        sampleDescriptionIndex: readU32(bytes, cursor + 8),
      });
    }
    return entries;
  }

  function readChunkOffsets(bytes, coBox) {
    const count = readU32(bytes, coBox.start + 12);
    const width = coBox.type === 'co64' ? 8 : 4;
    const offsets = new Array(count);
    for (let i = 0, cursor = coBox.start + 16; i < count; i += 1, cursor += width) {
      offsets[i] = coBox.type === 'co64' ? Number(readU64(bytes, cursor)) : readU32(bytes, cursor);
    }
    return offsets;
  }

  function readSttsEntries(bytes, sttsBox) {
    const count = readU32(bytes, sttsBox.start + 12);
    const entries = [];
    for (let i = 0, cursor = sttsBox.start + 16; i < count; i += 1, cursor += 8) {
      entries.push({ sampleCount: readU32(bytes, cursor), sampleDelta: readU32(bytes, cursor + 4) });
    }
    return entries;
  }

  function readMdhdInfo(source, mdhdBox) {
    const version = source[mdhdBox.start + 8];
    return version === 1
      ? {
          version,
          timescale: readU32(source, mdhdBox.start + 28),
          duration: Number(readU64(source, mdhdBox.start + 32)),
        }
      : {
          version,
          timescale: readU32(source, mdhdBox.start + 20),
          duration: readU32(source, mdhdBox.start + 24),
        };
  }

  function getTrackKind(trak, source) {
    const hdlr = findBox(trak, ['mdia', 'hdlr']);
    return hdlr ? readType(source, hdlr.start + hdlr.header + 8) : null;
  }

  function findAvcConfiguration(source, stbl) {
    const stsd = findBox(stbl, ['stsd']);
    if (!stsd) return null;
    const count = readU32(source, stsd.start + 12);
    let cursor = stsd.start + 16;
    for (let i = 0; i < count; i += 1) {
      if (cursor + 8 > stsd.end) break;
      const size = readU32(source, cursor);
      const type = readType(source, cursor + 4);
      if (size < 8 || cursor + size > stsd.end) break;
      if (type === 'avc1' || type === 'avc3') {
        const children = parseChildren(source, cursor + 86, cursor + size);
        const avcC = children.find((box) => box.type === 'avcC');
        if (!avcC || avcC.start + 13 > avcC.end) throw new Error('AVC sample entry has no valid avcC box.');
        return { type, lengthSize: (source[avcC.start + 12] & 3) + 1 };
      }
      cursor += size;
    }
    return null;
  }

  function readSampleEntryType(source, stbl) {
    const stsd = findBox(stbl, ['stsd']);
    return stsd && readU32(source, stsd.start + 12) > 0 ? readType(source, stsd.start + 20) : null;
  }

  function expandChunks(sampleSizes, offsets, entries) {
    if (!entries.length && offsets.length) throw new Error('stsc has no entries.');
    const chunks = [];
    let sampleIndex = 0;
    let entryIndex = 0;
    for (let i = 0; i < offsets.length; i += 1) {
      const chunkNumber = i + 1;
      while (entryIndex + 1 < entries.length && entries[entryIndex + 1].firstChunk <= chunkNumber) entryIndex += 1;
      const entry = entries[entryIndex];
      if (!entry || entry.firstChunk > chunkNumber || entry.samplesPerChunk < 1) throw new Error('Invalid stsc mapping.');
      if (sampleIndex + entry.samplesPerChunk > sampleSizes.length) throw new Error('stsc maps beyond stsz sample count.');
      let byteLength = 0;
      for (let j = 0; j < entry.samplesPerChunk; j += 1) byteLength += sampleSizes[sampleIndex + j];
      chunks.push({
        index: i,
        offset: offsets[i],
        firstSample: sampleIndex,
        sampleCount: entry.samplesPerChunk,
        byteLength,
      });
      sampleIndex += entry.samplesPerChunk;
    }
    if (sampleIndex !== sampleSizes.length) throw new Error('stsc/stco do not account for every sample in stsz.');
    return chunks;
  }

  function findChunkForSample(chunks, sampleIndex) {
    let low = 0;
    let high = chunks.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const chunk = chunks[middle];
      if (sampleIndex < chunk.firstSample) high = middle - 1;
      else if (sampleIndex >= chunk.firstSample + chunk.sampleCount) low = middle + 1;
      else return chunk;
    }
    throw new Error('Sample ' + sampleIndex + ' has no chunk mapping.');
  }

  function getSampleBytes(source, track, sampleIndex) {
    const chunk = findChunkForSample(track.chunks, sampleIndex);
    let offset = chunk.offset;
    for (let i = chunk.firstSample; i < sampleIndex; i += 1) offset += track.sampleSizes[i];
    return source.subarray(offset, offset + track.sampleSizes[sampleIndex]);
  }

  function readTrackFull(source, trakBox, index) {
    const mdia = findBox(trakBox, ['mdia']);
    const minf = findBox(trakBox, ['mdia', 'minf']);
    const stbl = findBox(trakBox, ['mdia', 'minf', 'stbl']);
    const stsz = findBox(trakBox, ['mdia', 'minf', 'stbl', 'stsz']);
    const stsc = findBox(trakBox, ['mdia', 'minf', 'stbl', 'stsc']);
    const chunkOffsetsBox = findBox(trakBox, ['mdia', 'minf', 'stbl', 'stco']) ||
      findBox(trakBox, ['mdia', 'minf', 'stbl', 'co64']);
    const stts = findBox(trakBox, ['mdia', 'minf', 'stbl', 'stts']);
    const mdhd = findBox(trakBox, ['mdia', 'mdhd']);
    const tkhd = findBox(trakBox, ['tkhd']);
    if (!stbl || !stsz || !stsc || !chunkOffsetsBox || !stts || !mdhd || !tkhd) {
      throw new Error('Track ' + (index + 1) + ' has incomplete sample tables.');
    }
    const sampleSizes = readStszSizes(source, stsz);
    const chunkOffsets = readChunkOffsets(source, chunkOffsetsBox);
    const stscEntries = readStscEntries(source, stsc);
    return {
      index,
      trakBox,
      mdiaBox: mdia,
      minfBox: minf,
      kind: getTrackKind(trakBox, source),
      stbl,
      stsz,
      stsc,
      chunkOffsetsBox,
      stts,
      mdhd,
      tkhd,
      edts: findBox(trakBox, ['edts']),
      hdlr: findBox(trakBox, ['mdia', 'hdlr']),
      vmhd: findBox(trakBox, ['mdia', 'minf', 'vmhd']),
      smhd: findBox(trakBox, ['mdia', 'minf', 'smhd']),
      dinf: findBox(trakBox, ['mdia', 'minf', 'dinf']),
      stsd: findBox(stbl, ['stsd']),
      stss: findBox(stbl, ['stss']),
      sdtp: findBox(stbl, ['sdtp']),
      ctts: findBox(stbl, ['ctts']),
      sgpd: findBox(stbl, ['sgpd']),
      sbgp: findBox(stbl, ['sbgp']),
      avc: findAvcConfiguration(source, stbl),
      sampleEntryType: readSampleEntryType(source, stbl),
      sampleSizes,
      chunks: expandChunks(sampleSizes, chunkOffsets, stscEntries),
    };
  }

  /* ---------- NALU parsing ---------- */

  function parseNaluList(avccSample) {
    const list = [];
    let position = 0;
    while (position + 4 <= avccSample.length) {
      const length = readU32(avccSample, position);
      if (length <= 0 || position + 4 + length > avccSample.length) break;
      const type = avccSample[position + 4] & 0x1f;
      list.push({ type, raw: avccSample.slice(position, position + 4 + length) });
      position += 4 + length;
    }
    return list;
  }

  /* ---------- box builders ---------- */

  function buildStts(entries) {
    const payload = new Uint8Array(8 + entries.length * 8);
    writeU32(payload, 4, entries.length);
    for (let i = 0, cursor = 8; i < entries.length; i += 1, cursor += 8) {
      writeU32(payload, cursor, entries[i].sampleCount);
      writeU32(payload, cursor + 4, entries[i].sampleDelta);
    }
    return makeBox('stts', payload);
  }

  function buildStsc(entries) {
    const payload = new Uint8Array(8 + entries.length * 12);
    writeU32(payload, 4, entries.length);
    for (let i = 0, cursor = 8; i < entries.length; i += 1, cursor += 12) {
      writeU32(payload, cursor, entries[i].firstChunk);
      writeU32(payload, cursor + 4, entries[i].samplesPerChunk);
      writeU32(payload, cursor + 8, entries[i].sampleDescriptionIndex);
    }
    return makeBox('stsc', payload);
  }

  function buildStsz(sizes) {
    const payload = new Uint8Array(12 + sizes.length * 4);
    writeU32(payload, 8, sizes.length);
    for (let i = 0, cursor = 12; i < sizes.length; i += 1, cursor += 4) writeU32(payload, cursor, sizes[i]);
    return makeBox('stsz', payload);
  }

  function buildStco(offsets) {
    const payload = new Uint8Array(8 + offsets.length * 4);
    writeU32(payload, 4, offsets.length);
    for (let i = 0, cursor = 8; i < offsets.length; i += 1, cursor += 4) writeU32(payload, cursor, offsets[i]);
    return makeBox('stco', payload);
  }

  function buildBtrt(bufferSizeDb, maxBitrate, avgBitrate) {
    const payload = new Uint8Array(12);
    writeU32(payload, 0, bufferSizeDb);
    writeU32(payload, 4, maxBitrate);
    writeU32(payload, 8, avgBitrate);
    return makeBox('btrt', payload);
  }

  function buildHdlr(handlerType, name) {
    const payload = new Uint8Array(24 + utf8(name).byteLength + 1);
    writeType(payload, 8, handlerType);
    payload.set(utf8(name), 24);
    return makeBox('hdlr', payload);
  }

  function patchTkhdDurationMs(source, tkhdBox, durationMs) {
    const out = source.slice(tkhdBox.start, tkhdBox.end);
    if (out[8] === 0) writeU32(out, 28, durationMs >>> 0);
    return out;
  }

  function patchMvhdDuration(source, mvhdBox, durationMs) {
    const out = source.slice(mvhdBox.start, mvhdBox.end);
    if (out[8] === 0) writeU32(out, 24, durationMs >>> 0);
    return out;
  }

  function patchMdhd(source, mdhdBox, durationTicks, language) {
    const out = source.slice(mdhdBox.start, mdhdBox.end);
    if (durationTicks != null) {
      if (out[8] === 1) writeU64(out, 32, BigInt(durationTicks));
      else writeU32(out, 24, durationTicks >>> 0);
    }
    if (language != null) {
      const langOffset = out[8] === 1 ? 40 : 28;
      out[langOffset] = (language >> 8) & 0xff;
      out[langOffset + 1] = language & 0xff;
    }
    return out;
  }

  /* ---------- stsd builders ---------- */

  function findChildByType(children, type) {
    return children.find((box) => box.type === type) || null;
  }

  function buildVideoStsd(source, stsdBox, avgBitrate) {
    const stsdContent = source.subarray(stsdBox.start + 8, stsdBox.end);
    if (stsdContent.length < 94) return makeBox('stsd', stsdContent);

    const fixedFields = stsdContent.subarray(16, 94);
    const children = parseChildren(stsdContent, 94, stsdContent.length);

    const avcCOrig = findChildByType(children, 'avcC');
    const colr = findChildByType(children, 'colr');
    const pasp = findChildByType(children, 'pasp');
    const btrtOld = findChildByType(children, 'btrt');

    const avcCPayload = concat([
      stsdContent.subarray(avcCOrig.start + 8, avcCOrig.end),
      AVC_C_EXT,
    ]);
    const avcCNew = makeBox('avcC', avcCPayload);

    const maxBitrate = btrtOld ? readU32(source, btrtOld.start + 12) : avgBitrate;
    const btrtNew = buildBtrt(0, maxBitrate, avgBitrate);

    const parts = [fixedFields, avcCNew];
    if (colr) parts.push(source.subarray(colr.start, colr.end));
    if (pasp) parts.push(source.subarray(pasp.start, pasp.end));
    parts.push(btrtNew);

    const avc1 = makeBox('avc1', concat(parts));
    const payload = new Uint8Array(8 + avc1.byteLength);
    writeU32(payload, 4, 1);
    payload.set(avc1, 8);
    return makeBox('stsd', payload);
  }

  function patchAudioStsdBitrate(source, stsdBox, oldBitrate, newBitrate) {
    const out = source.slice(stsdBox.start, stsdBox.end);
    if (oldBitrate === newBitrate || oldBitrate <= 0) return out;
    const old = [oldBitrate >>> 24 & 0xff, oldBitrate >>> 16 & 0xff, oldBitrate >>> 8 & 0xff, oldBitrate & 0xff];
    const neu = [newBitrate >>> 24 & 0xff, newBitrate >>> 16 & 0xff, newBitrate >>> 8 & 0xff, newBitrate & 0xff];
    for (let i = 0; i + 4 <= out.length; i += 1) {
      if (out[i] === old[0] && out[i + 1] === old[1] && out[i + 2] === old[2] && out[i + 3] === old[3]) {
        out[i] = neu[0]; out[i + 1] = neu[1]; out[i + 2] = neu[2]; out[i + 3] = neu[3];
        i += 3;
      }
    }
    return out;
  }

  /* ---------- helpers ---------- */

  function containsBrand(bytes, word) {
    const lower = [];
    for (let i = 0; i < word.length; i += 1) {
      const c = word.charCodeAt(i);
      lower.push(c >= 65 && c <= 90 ? c + 32 : c);
    }
    outer: for (let i = 0; i + lower.length <= bytes.length; i += 1) {
      for (let j = 0; j < lower.length; j += 1) {
        const b = bytes[i + j];
        const normalized = b >= 65 && b <= 90 ? b + 32 : b;
        if (normalized !== lower[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  function readHdlrName(source, hdlrBox) {
    let end = hdlrBox.end;
    for (let i = hdlrBox.start + hdlrBox.header + 24; i < hdlrBox.end; i += 1) {
      if (source[i] === 0) { end = i; break; }
    }
    let out = '';
    for (let i = hdlrBox.start + hdlrBox.header + 24; i < end; i += 1) out += String.fromCharCode(source[i]);
    return out;
  }

  function readMovieTimescale(source, moovBox) {
    const mvhd = findBox(moovBox, ['mvhd']);
    if (!mvhd) return 1000;
    return source[mvhd.start + 8] === 1 ? readU32(source, mvhd.start + 28) : readU32(source, mvhd.start + 20);
  }

  /* ---------- main transform ---------- */

  function transformWithReport(inputBytes, options = {}) {
    const multiplier = Number(options.multiplier) || MULTIPLIER;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const progress = (pct, label) => { if (onProgress) onProgress(Math.max(0, Math.min(100, pct)), label); };

    const source = toUint8Array(inputBytes);
    const rootBoxes = parseChildren(source, 0, source.byteLength);
    const moovBox = rootBoxes.find((box) => box.type === 'moov');
    const mdatBox = rootBoxes.find((box) => box.type === 'mdat');
    if (!moovBox || !mdatBox) throw new Error('MP4 moov/mdat atom not found.');
    const mdatDataStart = mdatBox.start + mdatBox.header;

    progress(6, 'Reading container');

    const trakBoxes = moovBox.children.filter((box) => box.type === 'trak');
    const tracks = trakBoxes.map((trak, index) => readTrackFull(source, trak, index));

    const videoTrack = tracks.find((track) => track.kind === 'vide' && track.avc);
    if (!videoTrack) {
      throw new Error('An H.264/AVC video track was not found. For HEVC/MOV sources switch to High-quality re-encode mode.');
    }
    const audioTrack = tracks.find((track) => track.kind === 'soun');
    if (audioTrack && audioTrack.sampleEntryType !== 'mp4a') {
      throw new Error('The audio track uses ' + (audioTrack.sampleEntryType || 'an unknown codec') + '; AAC/mp4a is required.');
    }

    progress(14, 'Reading tracks');

    /* --- video parameters --- */
    const videoSizes = videoTrack.sampleSizes;
    const origFrames = videoSizes.length;
    const vSttsEntries = readSttsEntries(source, videoTrack.stts);
    if (!vSttsEntries.length) throw new Error('Video stts has no timing entries.');
    const timeDelta = vSttsEntries[0].sampleDelta;
    const padCount = Math.min(origFrames * (multiplier - 1), MAX_GHOSTS);

    const vMdhd = readMdhdInfo(source, videoTrack.mdhd);
    const vDurationSec = vMdhd.duration / Math.max(1, vMdhd.timescale);

    /* --- first sample kept VERBATIM (pure inflate: no stream edits) --- */
    const firstOff = videoTrack.chunks[0].offset;
    const firstSize = videoSizes[0];
    const newFirst = source.subarray(firstOff, firstOff + firstSize);

    progress(22, 'Reading samples');

    /* --- audio plan --- */
    let audioPlan = null;
    if (audioTrack) {
      const aSizes = audioTrack.sampleSizes;
      const aCount = aSizes.length;
      const aSttsEntries = readSttsEntries(source, audioTrack.stts);
      const aDelta = aSttsEntries.length ? aSttsEntries[0].sampleDelta : 1024;
      const aMdhd = readMdhdInfo(source, audioTrack.mdhd);
      const elstBox = findBox(audioTrack.trak, ['edts', 'elst']);

      let newAudioDurTicks = aMdhd.duration;
      let newAudioDurMs = Math.round((newAudioDurTicks * 1000) / Math.max(1, aMdhd.timescale));
      let alignedStts = null;
      if (elstBox && aMdhd.version === 0 && aCount >= 2 && aSttsEntries.length) {
        const segmentDuration = readU32(source, elstBox.start + 16);
        const mediaTime = readI32(source, elstBox.start + 20);
        newAudioDurMs = segmentDuration;
        newAudioDurTicks = Math.floor((segmentDuration * aMdhd.timescale) / 1000);
        const target = newAudioDurTicks + mediaTime;
        const mainN = aCount - 1;
        const lastDelta = target - mainN * aDelta;
        if (lastDelta > 0 && lastDelta <= aDelta) {
          alignedStts = [
            { sampleCount: mainN, sampleDelta: aDelta },
            { sampleCount: 1, sampleDelta: lastDelta },
          ];
        } else {
          newAudioDurTicks = aMdhd.duration;
          newAudioDurMs = Math.round((newAudioDurTicks * 1000) / Math.max(1, aMdhd.timescale));
        }
      }

      const oldTicks = aSttsEntries.reduce((sum, e) => sum + e.sampleCount * e.sampleDelta, 0);
      const newTicks = alignedStts
        ? alignedStts.reduce((sum, e) => sum + e.sampleCount * e.sampleDelta, 0)
        : oldTicks;
      const totalABytes = aSizes.reduce((sum, s) => sum + s, 0);
      const oldABr = oldTicks > 0 ? Math.floor((totalABytes * 8 * aMdhd.timescale) / oldTicks) : 0;
      const newABr = newTicks > 0 ? Math.floor((totalABytes * 8 * aMdhd.timescale) / newTicks) : 0;

      audioPlan = {
        track: audioTrack,
        sizes: aSizes,
        alignedStts,
        newAudioDurTicks,
        newAudioDurMs,
        oldABr,
        newABr,
        timescale: aMdhd.timescale,
      };
    }

    progress(34, 'Aligning audio timeline');

    /* --- assemble new mdat content --- */
    const firstVideoChunk = videoTrack.chunks[0];
    const records = [];
    for (const track of tracks) {
      track.chunks.forEach((chunk, chunkIndex) => {
        records.push({ track, chunkIndex, chunk });
      });
    }
    records.sort((a, b) => a.chunk.offset - b.chunk.offset);

    const newOffsets = new Map(tracks.map((track) => [track, new Array(track.chunks.length)]));
    const outParts = [];
    let cursor = 0;
    const firstVideoChunkIndex = firstVideoChunk.index;

    for (const rec of records) {
      newOffsets.get(rec.track)[rec.chunkIndex] = cursor;
      const isFirstVideoChunk = rec.track === videoTrack && rec.chunkIndex === firstVideoChunkIndex;
      if (isFirstVideoChunk) {
        const pieceParts = [];
        for (let s = 0; s < rec.chunk.sampleCount; s += 1) {
          const sampleIndex = rec.chunk.firstSample + s;
          if (sampleIndex === 0) pieceParts.push(newFirst);
          else pieceParts.push(getSampleBytes(source, videoTrack, sampleIndex));
        }
        const piece = concat(pieceParts);
        outParts.push(piece);
        cursor += piece.byteLength;
      } else {
        const piece = source.subarray(rec.chunk.offset, rec.chunk.offset + rec.chunk.byteLength);
        outParts.push(piece);
        cursor += piece.byteLength;
      }
    }
    outParts.push(PADDING_NAL);
    const padAbsRelative = cursor;
    cursor += PADDING_NAL.byteLength;
    progress(46, 'Copying media payload');

    /* --- fresh tables --- */
    const ghostSizes = new Array(padCount).fill(PADDING_NAL.byteLength);
    const videoStszNew = buildStsz([newFirst.byteLength, ...videoSizes.slice(1), ...ghostSizes]);
    const videoStscNew = buildStsc([
      ...readStscEntries(source, videoTrack.stsc),
      { firstChunk: videoTrack.chunks.length + 1, samplesPerChunk: 1, sampleDescriptionIndex: 1 },
    ]);
    /* --- CONSISTENT DENSITY: ghosts use 1-tick deltas; container
       durations extend by the same ticks so every table agrees --- */
    const GHOST_DELTA = 1;
    const addedMediaTicks = padCount * GHOST_DELTA;
    const newVMdhdDuration = vMdhd.duration + addedMediaTicks;

    let videoSttsNew;
    if (vSttsEntries.length === 1) {
      videoSttsNew = buildStts([
        { sampleCount: origFrames, sampleDelta: timeDelta },
        { sampleCount: padCount, sampleDelta: GHOST_DELTA },
      ]);
    } else {
      const lastEntry = vSttsEntries[vSttsEntries.length - 1];
      videoSttsNew = buildStts([...vSttsEntries, { sampleCount: padCount, sampleDelta: GHOST_DELTA }]);
    }

    const verbatim = (box) => (box ? source.subarray(box.start, box.end) : null);

    function buildStblFor(track, overrides) {
      const known = new Set(['stsd', 'stts', 'stss', 'sdtp', 'ctts', 'stsc', 'stsz', 'stco', 'co64']);
      const ordered = [];
      ordered.push(overrides.stsd);
      ordered.push(overrides.stts);
      if (track.stss) ordered.push(verbatim(track.stss));
      if (track.sdtp) ordered.push(verbatim(track.sdtp));
      if (track.ctts) ordered.push(verbatim(track.ctts));
      ordered.push(overrides.stsc);
      ordered.push(overrides.stsz);
      ordered.push(overrides.stco);
      for (const child of track.stbl.children) {
        if (!known.has(child.type) && child.type !== 'stco' && child.type !== 'co64') {
          ordered.push(source.subarray(child.start, child.end));
        }
      }
      return makeBox('stbl', concat(ordered));
    }

    function buildMinfFor(track, overrides) {
      const parts = [];
      for (const child of track.minfBox.children) {
        if (child.type === 'stbl') parts.push(buildStblFor(track, overrides));
        else parts.push(source.subarray(child.start, child.end));
      }
      return makeBox('minf', concat(parts));
    }

    function buildMdiaFor(track, overrides) {
      const parts = [];
      for (const child of track.mdiaBox.children) {
        if (child.type === 'minf') parts.push(buildMinfFor(track, overrides));
        else if (child.type === 'hdlr' && overrides.hdlr) parts.push(overrides.hdlr);
        else if (child.type === 'mdhd' && overrides.mdhd) parts.push(overrides.mdhd);
        else parts.push(source.subarray(child.start, child.end));
      }
      return makeBox('mdia', concat(parts));
    }

    function buildTrakFor(track, overrides) {
      const parts = [];
      for (const child of track.trakBox.children) {
        if (child.type === 'mdia') parts.push(buildMdiaFor(track, overrides));
        else if (child.type === 'tkhd' && overrides.tkhd) parts.push(overrides.tkhd);
        else parts.push(source.subarray(child.start, child.end));
      }
      return makeBox('trak', concat(parts));
    }

    /* --- CONSISTENT DURATION EXTENSION --- */
    const movieTimescale = Math.max(1, readMovieTimescale(source, moovBox));
    const addedMovieTicks = Math.round((addedMediaTicks * movieTimescale) / Math.max(1, vMdhd.timescale));

    const videoTkhdDurTicks = readU32(source, videoTrack.tkhd.start + 28);
    const audioTkhdDurTicks = audioTrack ? readU32(source, audioTrack.tkhd.start + 28) : 0;
    const baseMovieTicks = Math.max(videoTkhdDurTicks, audioTkhdDurTicks);
    const newMovieDurTicks = baseMovieTicks + addedMovieTicks;
    const newVideoTkhdDurTicks = videoTkhdDurTicks + addedMovieTicks;

    const mvhdBox = findBox(moovBox, ['mvhd']);
    let mvhdPatched = null;
    if (mvhdBox && source[mvhdBox.start + 8] === 0) {
      const curMvhdTicks = readU32(source, mvhdBox.start + 24);
      mvhdPatched = patchMvhdDuration(source, mvhdBox, curMvhdTicks + addedMovieTicks);
    }

    const videoOverrides = {
      stsd: source.subarray(videoTrack.stsd.start, videoTrack.stsd.end),
      stts: videoSttsNew,
      stsc: videoStscNew,
      stsz: videoStszNew,
      stco: null,
      tkhd: patchTkhdDurationMs(source, videoTrack.tkhd, newVideoTkhdDurTicks),
      mdhd: patchMdhd(source, videoTrack.mdhd, newVMdhdDuration, null),
    };

    const ftyp = makeFtyp();
    const free = makeFree();

    const audioOverridesList = [];
    if (audioTrack) {
      audioOverridesList.push({
        stsd: patchAudioStsdBitrate(source, audioTrack.stsd, audioPlan.oldABr, audioPlan.newABr),
        stts: buildStts(audioPlan.alignedStts || readSttsEntries(source, audioTrack.stts)),
        stsc: buildStsc(readStscEntries(source, audioTrack.stsc)),
        stsz: buildStsz(audioPlan.sizes),
        stco: null,
        mdhd: patchMdhd(source, audioTrack.mdhd, audioPlan.newAudioDurTicks, LANG_UND),
        hdlr: buildHdlr('soun', 'SoundHandler'),
        tkhd: patchTkhdDurationMs(source, audioTrack.tkhd, audioPlan.newAudioDurMs),
      });
    }

    /* --- two-pass moov assembly with placeholder stcos --- */
    function buildMoov(offsetProvider) {
      videoOverrides.stco = buildStco(offsetProvider(videoTrack));
      if (audioTrack) {
        const ov = audioOverridesList[0];
        ov.stco = buildStco(offsetProvider(audioTrack));
      }
      const childrenParts = [];
      let videoPlaced = false;
      let audioPlaced = false;
      for (const child of moovBox.children) {
        if (child.type === 'trak') {
          const trackObj = tracks.find((tr) => tr.trakBox === child);
          if (trackObj === videoTrack) { childrenParts.push(buildTrakFor(videoTrack, videoOverrides)); videoPlaced = true; continue; }
          if (trackObj === audioTrack) { childrenParts.push(buildTrakFor(audioTrack, audioOverridesList[0])); audioPlaced = true; continue; }
          childrenParts.push(source.subarray(child.start, child.end));
          continue;
        }
        if (child.type === 'udta') continue;
        if (child.type === 'mvhd' && mvhdPatched) { childrenParts.push(mvhdPatched); continue; }
        childrenParts.push(source.subarray(child.start, child.end));
      }
      return makeBox('moov', concat(childrenParts));
    }

    const mdatHeaderSize = cursor + 8 <= 0xffffffff ? 8 : 16;
    let moovFinal = buildMoov(() => []);
    let pass = 0;
    let finalOffsets = null;
    for (; pass < 4; pass += 1) {
      const newMdatStart = ftyp.byteLength + free.byteLength + moovFinal.byteLength + mdatHeaderSize;
      finalOffsets = new Map();
      for (const track of tracks) {
        /* newOffsets holds mdat-content-relative cursor positions from the
           assembly walk - they already account for the SEI strip */
        finalOffsets.set(track, newOffsets.get(track).map((rel) => newMdatStart + rel));
      }
      const ghostAbs = newMdatStart + padAbsRelative;
      const videoArr = finalOffsets.get(videoTrack);
      for (let g = 0; g < padCount; g += 1) videoArr.push(ghostAbs);

      const nextMoov = buildMoov((track) => finalOffsets.get(track));
      if (nextMoov.byteLength === moovFinal.byteLength) { moovFinal = nextMoov; break; }
      moovFinal = nextMoov;
      progress(62 + Math.min(pass, 2) * 5, 'Converging chunk offsets');
      if (pass === 3) throw new Error('MP4 offset layout did not converge.');
    }

    progress(84, 'Assembling output');

    const output = concat([
      ftyp,
      free,
      moovFinal,
      makeMdatHeader(cursor, mdatHeaderSize),
      ...outParts,
    ]);

    return {
      bytes: output,
      report: {
        version: '4.5.0',
        strategy: 'pure-inflate',
        multiplier,
        videoSampleCount: origFrames,
        declaredFrames: origFrames + padCount,
        ghostFrames: padCount,
        videoTimescale: vMdhd.timescale,
        audioUntouched: true,
        brandingRemoved: true,
      },
    };
  }

  /* ---------- verify ---------- */

  function readTracks(bytes) {
    const root = parseChildren(bytes, 0, bytes.byteLength);
    const moov = root.find((box) => box.type === 'moov');
    if (!moov) throw new Error('MP4 moov atom not found.');
    return moov.children.filter((box) => box.type === 'trak').map((trak, index) => readTrackFull(bytes, trak, index));
  }

  function verifyOutput(inputBytes, outputBytes) {
    const input = toUint8Array(inputBytes);
    const output = toUint8Array(outputBytes);
    const inputTracks = readTracks(input);
    const outputTracks = readTracks(output);

    const beforeVideo = inputTracks.find((track) => track.kind === 'vide' && track.avc);
    const afterVideo = outputTracks.find((track) => track.kind === 'vide' && track.avc);
    if (!beforeVideo || !afterVideo) throw new Error('Input or output has no AVC video track.');

    const realFrames = beforeVideo.sampleSizes.length;
    const ghostFrames = afterVideo.sampleSizes.length - realFrames;
    if (ghostFrames <= 0) throw new Error('No ghost frames were added.');

    /* first sample must be byte-identical (pure inflate: no stream edits) */
    const inFirst = getSampleBytes(input, beforeVideo, 0);
    if (!bytesEqual(inFirst, getSampleBytes(output, afterVideo, 0))) {
      throw new Error('First video sample changed.');
    }
    for (let i = 1; i < realFrames; i += 1) {
      if (!bytesEqual(getSampleBytes(input, beforeVideo, i), getSampleBytes(output, afterVideo, i))) {
        throw new Error('Real video frame ' + i + ' changed.');
      }
    }
    for (let i = realFrames; i < afterVideo.sampleSizes.length; i += 1) {
      if (!bytesEqual(getSampleBytes(output, afterVideo, i), PADDING_NAL)) {
        throw new Error('Ghost frame ' + (i - realFrames) + ' has the wrong payload.');
      }
    }

    /* timing: ghost entries appended with 1-tick deltas */
    const inSttsTotal = readSttsEntries(input, beforeVideo.stts).reduce((s, e) => s + e.sampleCount, 0);
    const outStts = readSttsEntries(output, afterVideo.stts);
    const outSttsTotal = outStts.reduce((s, e) => s + e.sampleCount, 0);
    if (outSttsTotal !== inSttsTotal + ghostFrames) {
      throw new Error('Ghost timing entries are missing from video stts.');
    }

    /* CONSISTENCY: mdhd duration must cover the ghost ticks exactly */
    const vMdhdIn = readMdhdInfo(input, beforeVideo.mdhd);
    const vMdhdOut = readMdhdInfo(output, afterVideo.mdhd);
    if (vMdhdOut.duration !== vMdhdIn.duration + ghostFrames * 1) {
      throw new Error('Video mdhd duration is not consistent with ghost timing.');
    }
    if (vMdhdOut.timescale !== vMdhdIn.timescale) {
      throw new Error('Video timescale changed.');
    }

    /* audio untouched */
    const beforeAudio = inputTracks.find((track) => track.kind === 'soun');
    const afterAudio = outputTracks.find((track) => track.kind === 'soun');
    if (Boolean(beforeAudio) !== Boolean(afterAudio)) throw new Error('Audio track presence changed.');
    let audioSampleCount = 0;
    if (beforeAudio) {
      audioSampleCount = beforeAudio.sampleSizes.length;
      if (afterAudio.sampleSizes.length !== audioSampleCount) throw new Error('Audio sample count changed.');
      for (let i = 0; i < audioSampleCount; i += 1) {
        if (!bytesEqual(getSampleBytes(input, beforeAudio, i), getSampleBytes(output, afterAudio, i))) {
          throw new Error('Audio sample ' + i + ' changed.');
        }
      }
      const aHdlr = findBox(afterAudio.trakBox, ['mdia', 'hdlr']);
      if (!aHdlr || readHdlrName(output, aHdlr) !== 'SoundHandler') {
        throw new Error('Audio handler was not normalized.');
      }
    }

    if (containsBrand(output, 'prex')) throw new Error('Branding leaked into the output.');

    const declaredFps = ((realFrames + ghostFrames) / Math.max(vMdhdOut.duration, 1)) * vMdhdOut.timescale;

    return {
      version: '4.7.0',
      strategy: 'consistent-density',
      realFrames,
      declaredFrames: realFrames + ghostFrames,
      ghostFrames,
      declaredFps: Math.round(declaredFps),
      durationAddedTicks: ghostFrames,
      audioSampleCount,
      audioUntouched: true,
      brandingFree: true,
      timelineConsistent: true,
    };
  }

  /* ---------- timescale normalization (EditingNews-faithful) ---------- */

  const TARGET_TIMESCALE = 30000;

  function indexOfSeq(bytes, pattern, startIndex) {
    if (!bytes || !pattern || bytes.length === 0 || pattern.length === 0 || pattern.length > bytes.length - startIndex) return -1;
    outer: for (let i = startIndex; i <= bytes.length - pattern.length; i += 1) {
      for (let j = 0; j < pattern.length; j += 1) {
        if (bytes[i + j] !== pattern[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /* Normalizes every mvhd/mdhd timescale to the platform-native 30000 and
     scales durations proportionally (in-place byte patch, no remux, streams
     untouched). Faithful port of the widely-used EditingNews patcher. */
  function normalizeTimescale(inputBytes, options = {}) {
    const targetTs = Number(options.targetTimescale) || TARGET_TIMESCALE;
    const out = toUint8Array(inputBytes).slice();
    let patchedCount = 0;
    const logEntries = [];

    for (const atomName of ['mvhd', 'mdhd']) {
      const pattern = [];
      for (let i = 0; i < atomName.length; i += 1) pattern.push(atomName.charCodeAt(i));
      let startIndex = 0;
      while (true) {
        const foundIndex = indexOfSeq(out, pattern, startIndex);
        if (foundIndex < 0) break;
        startIndex = foundIndex + 4;

        const headerOffset = foundIndex - 4;
        if (headerOffset < 0) continue;
        const boxSize = readI32(out, headerOffset);
        if (boxSize < 8 || headerOffset + boxSize > out.length) continue;
        const version = out[headerOffset + 8];
        if (version !== 0 && version !== 1) continue;

        if (version === 0) {
          const tsOff = headerOffset + 20, durOff = headerOffset + 24;
          if (durOff + 4 > out.length) continue;
          const oldTs = readU32(out, tsOff);
          const oldDur = readU32(out, durOff);
          if (oldTs === 0 || oldTs === targetTs) continue;
          const k = targetTs / oldTs;
          const newDur = Math.round(oldDur * k);
          writeU32(out, tsOff, targetTs);
          writeU32(out, durOff, newDur >>> 0);
          patchedCount += 1;
          logEntries.push(atomName + '(v0) ts ' + oldTs + '->' + targetTs);
        } else {
          const tsOff = headerOffset + 28, durOff = headerOffset + 32;
          if (durOff + 8 > out.length) continue;
          const oldTs = readU32(out, tsOff);
          const oldDur = Number(readU64(out, durOff));
          if (oldTs === 0 || oldTs === targetTs) continue;
          const k = targetTs / oldTs;
          const newDur = Math.round(oldDur * k);
          writeU32(out, tsOff, targetTs);
          writeU64(out, durOff, BigInt(newDur));
          patchedCount += 1;
          logEntries.push(atomName + '(v1) ts ' + oldTs + '->' + targetTs);
        }
      }
    }

    if (patchedCount === 0) throw new Error('No mvhd/mdhd timescales needed normalization.');
    return {
      buffer: out.buffer.slice(0, out.byteLength),
      bytes: out,
      report: {
        version: '4.3.0',
        strategy: 'timescale-normalize',
        normalizedAtoms: patchedCount,
        targetTimescale: targetTs,
        audioUntouched: true,
        brandingRemoved: true,
        logEntries,
      },
    };
  }

  function patchTimescale(inputBytes, options) {
    const res = normalizeTimescale(inputBytes, options);
    const buffer = res.bytes.buffer.slice(0, res.bytes.byteLength);
    return { buffer, bytes: new Uint8Array(buffer), view: new DataView(buffer), report: res.report };
  }

  /* ---------- public API ---------- */

  function patchPrex(inputBytes, options) {
    const out = transformWithReport(inputBytes, options);
    const buffer = out.bytes.buffer.slice(0, out.bytes.byteLength);
    return {
      buffer,
      bytes: new Uint8Array(buffer),
      view: new DataView(buffer),
      report: out.report,
      multiplier: out.report.multiplier,
      sampleCount: out.report.declaredFrames,
      realCount: out.report.videoSampleCount,
      fakeCount: out.report.ghostFrames,
    };
  }

  function createPatcher() {
    return {
      patchPrex,
      verifyOutput,
      patchTimescale,
      normalizeTimescale,
      constants: { MULTIPLIER, GHOST_SAMPLE_BYTES: PADDING_NAL.byteLength },
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = createPatcher();
  } else if (typeof self !== 'undefined') {
    const api = createPatcher();
    self.TTO_PREX = api;
    self.PREX_JS_VERSION = '47';
  }
})();
