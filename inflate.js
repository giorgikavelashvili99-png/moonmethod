(function () {
  'use strict';

  const MAX_TARGET_FPS = 120;
  const MAX_MULTIPLIER = 10;
  const MIN_MULTIPLIER = 2;

  const PAD_MIN = 48;
  const PAD_MAX = 128;
  const ENCODER_COMMENT = 'Lavf60.3.100';
  const ENCODER_KEY = '\u00a9too';
  const LANG_UND = 0x55c4;
  const KEEP_NALU_TYPES = new Set([1, 5]);

  /* ---------- low level ---------- */

  function parseBoxes(bytes, view, start, end) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      const rawSize = view.getUint32(offset, false);
      let size;
      let is64Bit = false;
      if (rawSize === 0) {
        size = end - offset;
      } else if (rawSize === 1) {
        is64Bit = true;
        if (offset + 16 > end) break;
        const hi = view.getUint32(offset + 8, false);
        const lo = view.getUint32(offset + 12, false);
        const sizeBig = (BigInt(hi) << 32n) + BigInt(lo);
        if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) break;
        size = Number(sizeBig);
      } else {
        size = rawSize;
      }
      if (size < 8 || offset + size > end) break;
      boxes.push({
        offset,
        size,
        type: String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]),
        end: offset + size,
        is64Bit,
      });
      offset += size;
    }
    return boxes;
  }

  function boxHeaderSize(box) {
    return box.is64Bit ? 16 : 8;
  }

  function setBoxSize(view, offset, box, added) {
    if (box.is64Bit) {
      view.setBigUint64(offset + 8, BigInt(box.size + added), false);
    } else {
      view.setUint32(offset, box.size + added, false);
    }
  }

  function buildBox(type, body) {
    const out = new Uint8Array(8 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, 8 + body.length, false);
    out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
    out.set(body, 8);
    return out;
  }

  function u32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, false);
    return b;
  }

  function readU32(bytes, off) {
    return (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
  }

  /* ---------- container helpers ---------- */

  function findBox(bytes, view, type, start, end) {
    for (const b of parseBoxes(bytes, view, start, end)) {
      if (b.type === type) return b;
    }
    return null;
  }

  function children(bytes, view, box) {
    return parseBoxes(bytes, view, box.offset + boxHeaderSize(box), box.end);
  }

  function handlerType(bytes, hdlrBox) {
    const hs = boxHeaderSize(hdlrBox);
    if (hdlrBox.offset + hs + 12 > hdlrBox.end) return null;
    return String.fromCharCode(bytes[hdlrBox.offset + hs + 8], bytes[hdlrBox.offset + hs + 9], bytes[hdlrBox.offset + hs + 10], bytes[hdlrBox.offset + hs + 11]);
  }

  function detectCodecFromStsd(bytes, stsdBox) {
    const hs = boxHeaderSize(stsdBox);
    const contentStart = stsdBox.offset + hs;
    if (contentStart + 16 > stsdBox.end) return 'unknown';
    return String.fromCharCode(bytes[contentStart + 12], bytes[contentStart + 13], bytes[contentStart + 14], bytes[contentStart + 15]);
  }

  function detectCodecFromStbl(bytes, view, stblBox) {
    const stsd = findBox(bytes, view, 'stsd', stblBox.offset + boxHeaderSize(stblBox), stblBox.end);
    return stsd ? detectCodecFromStsd(bytes, stsd) : 'unknown';
  }

  function readStts(bytes, view, sttsBox) {
    const hs = boxHeaderSize(sttsBox);
    const count = view.getUint32(sttsBox.offset + hs + 4, false);
    const entries = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const c = view.getUint32(sttsBox.offset + hs + 8 + i * 8, false);
      const d = view.getUint32(sttsBox.offset + hs + 8 + i * 8 + 4, false);
      entries.push([c, d]);
      total += c;
    }
    return { entries, count: total, totalDuration: entries.reduce((s, e) => s + e[0] * e[1], 0) };
  }

  function readStsz(bytes, view, stszBox) {
    const hs = boxHeaderSize(stszBox);
    const count = view.getUint32(stszBox.offset + hs + 8, false);
    const sizes = [];
    for (let i = 0; i < count; i++) {
      sizes.push(view.getUint32(stszBox.offset + hs + 12 + i * 4, false));
    }
    return sizes;
  }

  function readStsc(bytes, view, stscBox) {
    const hs = boxHeaderSize(stscBox);
    const count = view.getUint32(stscBox.offset + hs + 4, false);
    const entries = [];
    for (let i = 0; i < count; i++) {
      entries.push([
        view.getUint32(stscBox.offset + hs + 8 + i * 12, false),
        view.getUint32(stscBox.offset + hs + 8 + i * 12 + 4, false),
        view.getUint32(stscBox.offset + hs + 8 + i * 12 + 8, false),
      ]);
    }
    return entries;
  }

  function readChunkOffsets(bytes, view, chunkBox) {
    const hs = boxHeaderSize(chunkBox);
    const count = view.getUint32(chunkBox.offset + hs + 4, false);
    const offsets = [];
    if (chunkBox.type === 'co64') {
      for (let i = 0; i < count; i++) {
        offsets.push(Number(view.getBigUint64(chunkBox.offset + hs + 8 + i * 8, false)));
      }
    } else {
      for (let i = 0; i < count; i++) {
        offsets.push(view.getUint32(chunkBox.offset + hs + 8 + i * 4, false));
      }
    }
    return offsets;
  }

  function readMdhd(bytes, view, mdhdBox) {
    const hs = boxHeaderSize(mdhdBox);
    const contentStart = mdhdBox.offset + hs;
    const version = bytes[contentStart] & 0xff;
    if (version === 1) {
      return { timescale: view.getUint32(contentStart + 20, false), duration: view.getUint32(contentStart + 24, false), version: 1 };
    }
    return { timescale: view.getUint32(contentStart + 12, false), duration: view.getUint32(contentStart + 16, false), version: 0 };
  }

  function buildMdhd(origBox, version, lang, durationTicks) {
    const body = new Uint8Array(origBox.length - 8);
    body.set(origBox.subarray(8));
    const v = new DataView(body.buffer);
    const langOff = version === 1 ? 32 : 20;
    v.setUint16(langOff, lang & 0xffff, false);
    if (durationTicks != null && durationTicks > 0) {
      if (version === 1) v.setBigUint64(24, BigInt(Math.floor(durationTicks)), false);
      else v.setUint32(16, Math.floor(durationTicks) >>> 0, false);
    }
    return buildBox('mdhd', body);
  }

  function buildUdtaTag(key, value) {
    const dataBody = new Uint8Array(8 + value.length);
    const dv = new DataView(dataBody.buffer);
    dv.setUint32(0, 1, false);
    dv.setUint32(4, 0, false);
    for (let i = 0; i < value.length; i++) dataBody[8 + i] = value.charCodeAt(i) & 0xff;
    const dataBox = buildBox('data', dataBody);
    const tag = new Uint8Array(8 + dataBox.length);
    const cv = new DataView(tag.buffer);
    cv.setUint32(0, 8 + dataBox.length, false);
    tag.set([key.charCodeAt(0) & 0xff, key.charCodeAt(1) & 0xff, key.charCodeAt(2) & 0xff, key.charCodeAt(3) & 0xff], 4);
    tag.set(dataBox, 8);
    const ilst = buildBox('ilst', tag);
    const metaHdlr = buildBox('hdlr', concat([new Uint8Array(8), new Uint8Array([0x6d, 0x64, 0x69, 0x72, 0x61, 0x70, 0x70, 0x6c]), new Uint8Array(9)]));
    const meta = buildBox('meta', concat([u32(0), metaHdlr, ilst]));
    return buildBox('udta', meta);
  }

  function hashSeed(bytes, n) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < n; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s >>> 0;
    };
  }

  function buildPadBlock(codec, len, rng) {
    const isHevc = codec === 'hvc1' || codec === 'hev1';
    const head = isHevc ? [0x00, 0x00, 0x00, 0x01, 0x40, 0x41] : [0x00, 0x00, 0x00, 0x01, 0x09, 0x10];
    const blk = new Uint8Array(len);
    let pos = 0;
    for (; pos < head.length && pos < len; pos++) blk[pos] = head[pos];
    for (; pos < len - 1; pos++) blk[pos] = rng() & 0xff;
    if (pos < len) blk[pos] = 0x80;
    return blk;
  }

  function buildPaddedStts(realCount, avgDelta, padCount, rng) {
    const entries = [[realCount, avgDelta]];
    if (padCount <= 0) return entries;
    const target = padCount * avgDelta;
    const n1 = Math.floor(padCount / 3);
    const n2 = Math.floor(padCount / 3);
    const n3 = padCount - n1 - n2;
    const d1 = Math.max(1, avgDelta + (rng() % 3) - 1);
    const d2 = Math.max(1, avgDelta + (rng() % 3) - 1);
    let d3r = n3 > 0 ? Math.round((target - n1 * d1 - n2 * d2) / n3) : 0;
    if (d3r < 1) d3r = 1;
    const used = n1 * d1 + n2 * d2 + n3 * d3r;
    const last = d3r + (target - used);
    const segs = [[n1, d1], [n2, d2]];
    if (n3 > 1) segs.push([n3 - 1, d3r]);
    segs.push([1, last]);
    for (const [c, d] of segs) {
      if (c <= 0 || d <= 0) continue;
      if (entries.length && entries[entries.length - 1][1] === d) entries[entries.length - 1][0] += c;
      else entries.push([c, d]);
    }
    return entries;
  }

  function computeAudioTiming(bytes, view, t, targetMs) {
    const aTimescale = t.mdhdInfo.timescale;
    if (!aTimescale || !t.sttsInfo.count) return null;
    const targetTicks = Math.round((targetMs * aTimescale) / 1000);
    const totalTicks = t.sttsInfo.totalDuration;
    if (targetTicks >= totalTicks || targetTicks <= 0) return null;
    const entries = t.sttsInfo.entries;
    const aDelta = entries[0][1];
    if (aDelta <= 0) return null;
    const mainN = t.sttsInfo.count - 1;
    if (mainN <= 0) return null;
    const lastDelta = targetTicks - mainN * aDelta;
    if (lastDelta <= 0 || lastDelta > aDelta) return null;
    return { stts: [[mainN, aDelta], [1, lastDelta]], mdhdDur: targetTicks, aTimescale, totalBytes: t.sizes.reduce((s, x) => s + x, 0) };
  }

  function patchAudioStsd(stsdBytes, oldBr, newBr) {
    if (stsdBytes.length < 8 || oldBr <= 0 || newBr <= 0 || oldBr === newBr) return stsdBytes;
    const out = new Uint8Array(stsdBytes);
    const dv = new DataView(out.buffer);
    let i = 0;
    while (i + 4 <= out.length) {
      if (readU32(out, i) === oldBr) {
        dv.setUint32(i, newBr >>> 0, false);
        i += 4;
      } else {
        i += 1;
      }
    }
    return out;
  }

  function buildHdlr(handler, name) {
    const body = new Uint8Array(8 + 12 + name.length + 1);
    new DataView(body.buffer).setUint32(0, 0, false);
    body.set([handler.charCodeAt(0), handler.charCodeAt(1), handler.charCodeAt(2), handler.charCodeAt(3)], 8);
    for (let i = 0; i < name.length; i++) body[20 + i] = name.charCodeAt(i);
    return buildBox('hdlr', body);
  }

  function buildStts(entries) {
    const body = new Uint8Array(8 + entries.length * 8);
    const v = new DataView(body.buffer);
    v.setUint32(0, 0, false);
    v.setUint32(4, entries.length, false);
    entries.forEach(([c, d], i) => {
      v.setUint32(8 + i * 8, c, false);
      v.setUint32(8 + i * 8 + 4, d, false);
    });
    return buildBox('stts', body);
  }

  function buildStsc(entries) {
    const body = new Uint8Array(8 + entries.length * 12);
    const v = new DataView(body.buffer);
    v.setUint32(0, 0, false);
    v.setUint32(4, entries.length, false);
    entries.forEach(([fc, spc, sdi], i) => {
      v.setUint32(8 + i * 12, fc, false);
      v.setUint32(8 + i * 12 + 4, spc, false);
      v.setUint32(8 + i * 12 + 8, sdi, false);
    });
    return buildBox('stsc', body);
  }

  function buildStsz(sizes) {
    const body = new Uint8Array(12 + sizes.length * 4);
    const v = new DataView(body.buffer);
    v.setUint32(0, 0, false);
    v.setUint32(4, 0, false);
    v.setUint32(8, sizes.length, false);
    sizes.forEach((s, i) => v.setUint32(12 + i * 4, s, false));
    return buildBox('stsz', body);
  }

  function buildStco(offsets) {
    const body = new Uint8Array(8 + offsets.length * 4);
    const v = new DataView(body.buffer);
    v.setUint32(0, 0, false);
    v.setUint32(4, offsets.length, false);
    offsets.forEach((o, i) => v.setUint32(8 + i * 4, o >>> 0, false));
    return buildBox('stco', body);
  }

  function buildFtyp(isHevc) {
    const compat = isHevc ? 'isomiso2hvc1mp41' : 'isomiso2avc1mp41';
    const out = new Uint8Array(32);
    const v = new DataView(out.buffer);
    v.setUint32(0, 32, false);
    out.set([0x66, 0x74, 0x79, 0x70], 4);
    out.set([0x69, 0x73, 0x6f, 0x6d], 8);
    v.setUint32(12, 0x00000200, false);
    for (let i = 0; i < compat.length; i++) out[16 + i] = compat.charCodeAt(i);
    return out;
  }

  /* ---------- NAL handling (AVC, length-prefixed) ---------- */

  function parseAvcNalus(sample) {
    const nalus = [];
    let off = 0;
    while (off + 4 <= sample.length) {
      const len = readU32(sample, off);
      if (len === 0 || off + 4 + len > sample.length) break;
      nalus.push({ type: sample[off + 4] & 0x1f, start: off, len });
      off += 4 + len;
    }
    return nalus;
  }

  function stripSei(sample) {
    const nalus = parseAvcNalus(sample);
    if (nalus.length === 0) return sample;
    const kept = nalus.filter((n) => KEEP_NALU_TYPES.has(n.type));
    if (kept.length === 0 || kept.length === nalus.length) return sample;
    const out = new Uint8Array(kept.reduce((s, n) => s + 4 + n.len, 0));
    let pos = 0;
    for (const n of kept) {
      out.set(sample.subarray(n.start, n.start + 4 + n.len), pos);
      pos += 4 + n.len;
    }
    return out;
  }

  function patchAvcc(avccBoxBytes) {
    const content = avccBoxBytes.subarray(8);
    if (content.length < 6) return avccBoxBytes;
    const profile = content[1];
    const needsExt = profile >= 100;
    let hasExt = false;
    if (content.length >= 7) {
      const spsCount = content[6] & 0x1f;
      let p = 7;
      for (let i = 0; i < spsCount && p + 2 <= content.length; i++) {
        const len = readU32(content, p);
        p += 4 + len;
      }
      if (p + 1 <= content.length) {
        const ppsCount = content[p];
        p += 1;
        for (let i = 0; i < ppsCount && p + 2 <= content.length; i++) {
          const len = readU32(content, p);
          p += 4 + len;
        }
      }
      hasExt = p < content.length;
    }
    if (!needsExt || hasExt) return avccBoxBytes;
    const newContent = new Uint8Array(content.length + 4);
    newContent.set(content);
    newContent.set([0xfd, 0xf8, 0xf8, 0x00], content.length);
    return buildBox('avcC', newContent);
  }

  /* ---------- track analysis ---------- */

  function analyzeTrak(bytes, view, trak, isVideo) {
    const kids = children(bytes, view, trak);
    const mdia = kids.find((b) => b.type === 'mdia');
    if (!mdia) return null;
    const mdiaKids = children(bytes, view, mdia);
    const mdhd = mdiaKids.find((b) => b.type === 'mdhd');
    const hdlr = mdiaKids.find((b) => b.type === 'hdlr');
    const minf = mdiaKids.find((b) => b.type === 'minf');
    if (!hdlr || !minf) return null;
    const minfKids = children(bytes, view, minf);
    const stbl = minfKids.find((b) => b.type === 'stbl');
    if (!stbl) return null;
    const stblKids = children(bytes, view, stbl);
    const stsd = stblKids.find((b) => b.type === 'stsd');
    const stts = stblKids.find((b) => b.type === 'stts');
    const stsz = stblKids.find((b) => b.type === 'stsz');
    const stsc = stblKids.find((b) => b.type === 'stsc');
    const stco = stblKids.find((b) => b.type === 'stco');
    const co64 = stblKids.find((b) => b.type === 'co64');
    if (!stsd || !stts || !stsz || !stsc || (!stco && !co64)) return null;
    return {
      trak, mdia, mdhd, hdlr, minf, stbl, stblKids,
      stsd, stts, stsz, stsc, stco, co64,
      mdhdInfo: readMdhd(bytes, view, mdhd),
      sttsInfo: readStts(bytes, view, stts),
      sizes: readStsz(bytes, view, stsz),
      stscEntries: readStsc(bytes, view, stsc),
      chunkOffsets: readChunkOffsets(bytes, view, stco || co64),
      codec: detectCodecFromStsd(bytes, stsd),
      isVideo,
    };
  }

  function sliceBox(bytes, box) {
    return bytes.subarray(box.offset, box.end);
  }

  /* ---------- normalize (faststart + ftyp + metadata scrub, no inflation) ---------- */

  function normalizeContainer(inputBytes, inputView) {
    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === 'moov');
    const mdatBox = topBoxes.find((b) => b.type === 'mdat');
    if (!moovBox) return { newBuffer: null, newBytes: inputBytes, newView: inputView, changed: false, valid: false };
    if (!mdatBox) return { newBuffer: null, newBytes: inputBytes, newView: inputView, changed: false, valid: true };

    const ftypBox = topBoxes.find((b) => b.type === 'ftyp');
    const moovBeforeMdat = moovBox.offset < mdatBox.offset;
    let majorIsom = false;
    if (ftypBox) {
      const cs = ftypBox.offset + boxHeaderSize(ftypBox);
      majorIsom = inputBytes[cs] === 0x69 && inputBytes[cs + 1] === 0x73 && inputBytes[cs + 2] === 0x6f && inputBytes[cs + 3] === 0x6d;
    }

    const hasDirtyMeta = hasMetadataFingerprint(inputBytes, inputView, moovBox);
    if (moovBeforeMdat && majorIsom && !hasDirtyMeta) {
      return { newBuffer: null, newBytes: inputBytes, newView: inputView, changed: false, valid: true };
    }

    const codec = detectCodecFromStbl(inputBytes, inputView, (() => {
      const moovKids = children(inputBytes, inputView, moovBox);
      for (const trak of moovKids.filter((b) => b.type === 'trak')) {
        const t = analyzeTrak(inputBytes, inputView, trak, true);
        if (t) return t.stbl;
      }
      return null;
    })());
    const ftypBytes = ftypBox ? sliceBox(inputBytes, ftypBox) : buildFtyp(codec === 'hvc1' || codec === 'hev1');
    const scrubbedMoov = scrubMoov(inputBytes, inputView, moovBox);
    const moovBytes = scrubbedMoov.bytes;

    const newSize = ftypBytes.length + moovBytes.length + mdatBox.size;
    const newBuffer = new ArrayBuffer(newSize);
    const newBytes = new Uint8Array(newBuffer);
    const newView = new DataView(newBuffer);
    let writePos = 0;
    newBytes.set(ftypBytes, writePos);
    writePos += ftypBytes.length;
    newBytes.set(moovBytes, writePos);
    const newMoovOffset = writePos;
    writePos += moovBytes.length;
    newBytes.set(inputBytes.subarray(mdatBox.offset, mdatBox.end), writePos);
    const newMdatOffset = newMoovOffset + moovBytes.length;
    const delta = newMdatOffset - mdatBox.offset;
    if (delta !== 0) {
      updateChunkOffsets(newBytes, newView, newMoovOffset + 8, newMoovOffset + moovBytes.length, delta);
    }
    return { newBuffer, newBytes, newView, changed: true, valid: true, scrubbed: true };
  }

  function hasMetadataFingerprint(bytes, view, moovBox) {
    for (const b of children(bytes, view, moovBox)) {
      if (b.type === 'udta' || b.type === 'meta') return true;
      if (b.type === 'trak') {
        const t = analyzeTrak(bytes, view, b, false);
        if (!t) continue;
        const hType = handlerType(bytes, t.hdlr);
        const lang = t.mdhdInfo && t.mdhdInfo.version === 0 ? view.getUint16(t.mdhd.offset + boxHeaderSize(t.mdhd) + 20, false) : 0;
        if (hType === 'vide' || hType === 'soun') {
          const hdlrBody = bytes.subarray(t.hdlr.offset + boxHeaderSize(t.hdlr), t.hdlr.end);
          const nameBytes = hdlrBody.subarray(20);
          const name = String.fromCharCode(...Array.from(nameBytes)).replace(/\0.*$/, '');
          const langCode = (lang >> 16) & 0xffff;
          if (name && name !== 'VideoHandler' && name !== 'SoundHandler') return true;
          if (langCode !== 0 && langCode !== LANG_UND) return true;
        }
      }
    }
    return false;
  }

  function scanEditorFingerprint(bytes, view, moovBox) {
    const suspects = [];
    const seen = new Set();
    function walk(box, depth) {
      if (depth > 12 || seen.has(box.offset)) return;
      seen.add(box.offset);
      if (box.type === 'mebx' || box.type === 'scpt' || box.type === 'prj') {
        if (suspects.indexOf(box.type) === -1) suspects.push(box.type);
      }
      const kids = children(bytes, view, box);
      for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    }
    for (const kid of children(bytes, view, moovBox)) walk(kid, 0);
    return suspects;
  }

  function scrubMoov(bytes, view, moovBox) {
    const parts = [];
    for (const kid of children(bytes, view, moovBox)) {
      if (kid.type === 'udta' || kid.type === 'meta') continue;
      if (kid.type === 'trak') {
        const t = analyzeTrak(bytes, view, kid, false);
        if (t) {
          const hType = handlerType(bytes, t.hdlr);
          if (hType === 'vide' || hType === 'soun') {
            parts.push(rebuildTrak(bytes, view, t));
            continue;
          }
        }
      }
      parts.push(sliceBox(bytes, kid));
    }
    return { bytes: buildBox('moov', concat(parts)) };
  }

  function concat(parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }

  function rebuildTrak(bytes, view, t) {
    const mdiaParts = [];
    const hType = handlerType(bytes, t.hdlr);
    const name = hType === 'vide' ? 'VideoHandler' : 'SoundHandler';
    mdiaParts.push(buildMdhd(sliceBox(bytes, t.mdhd), t.mdhdInfo.version, LANG_UND));
    mdiaParts.push(buildHdlr(hType, name));

    const minfKids = children(bytes, view, t.minf);
    const mediaHeader = minfKids.find((b) => b.type === 'vmhd' || b.type === 'smhd');
    const dinf = minfKids.find((b) => b.type === 'dinf');
    const minfParts = [];
    if (mediaHeader) minfParts.push(sliceBox(bytes, mediaHeader));
    if (dinf) minfParts.push(sliceBox(bytes, dinf));

    const stblKids = children(bytes, view, t.stbl);
    const stblParts = [];
    for (const kid of stblKids) {
      // keep stco/co64: updateChunkOffsets patches their values in place
      // after the moov is re-positioned (dropping them produced an unplayable
      // file with no chunk-offset table).
      stblParts.push(sliceBox(bytes, kid));
    }
    minfParts.push(buildBox('stbl', concat(stblParts)));
    mdiaParts.push(buildBox('minf', concat(minfParts)));
    const mdia = buildBox('mdia', concat(mdiaParts));

    const trakKids = children(bytes, view, t.trak);
    const trakParts = [];
    for (const kid of trakKids) {
      if (kid.type === 'mdia') continue;
      trakParts.push(sliceBox(bytes, kid));
    }
    trakParts.push(mdia);
    return buildBox('trak', concat(trakParts));
  }

  function updateChunkOffsets(bytes, view, boxStart, boxEnd, delta) {
    const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
    for (const box of parseBoxes(bytes, view, boxStart, boxEnd)) {
      if (box.type === 'stco') {
        const hs = boxHeaderSize(box);
        const count = view.getUint32(box.offset + hs + 4, false);
        for (let i = 0; i < count; i++) {
          const pos = box.offset + hs + 8 + i * 4;
          view.setUint32(pos, view.getUint32(pos, false) + delta, false);
        }
      } else if (box.type === 'co64') {
        const hs = boxHeaderSize(box);
        const count = view.getUint32(box.offset + hs + 4, false);
        for (let i = 0; i < count; i++) {
          const pos = box.offset + hs + 8 + i * 8;
          view.setBigUint64(pos, view.getBigUint64(pos, false) + BigInt(delta), false);
        }
      } else if (containers.has(box.type)) {
        updateChunkOffsets(bytes, view, box.offset + boxHeaderSize(box), box.end, delta);
      }
    }
  }

  /* ---------- full rebuild inflate (proven recipe) ---------- */

  function buildVideoStsd(bytes, view, stsdBox, totalVideoBytes, durationSec, codec) {
    if (codec !== 'avc1' && codec !== 'avc3') return sliceBox(bytes, stsdBox);
    const content = bytes.subarray(stsdBox.offset + boxHeaderSize(stsdBox), stsdBox.end);
    if (content.length < 16 + 78) return sliceBox(bytes, stsdBox);

    const head = content.subarray(0, 8);
    const avc1Fixed = new Uint8Array(content.subarray(16, 16 + 78));
    avc1Fixed.fill(0, 42, 74);

    let avcC = null;
    let colr = null;
    let pasp = null;
    let btrtMax = null;
    const searchStart = 8 + 8 + 78;
    let pos = searchStart;
    while (pos + 8 <= content.length) {
      const size = readU32(content, pos);
      if (size < 8 || pos + size > content.length) break;
      const type = String.fromCharCode(content[pos + 4], content[pos + 5], content[pos + 6], content[pos + 7]);
      if (type === 'avcC') avcC = content.subarray(pos, pos + size);
      if (type === 'colr') colr = content.subarray(pos, pos + size);
      if (type === 'pasp') pasp = content.subarray(pos, pos + size);
      if (type === 'btrt' && size >= 20) btrtMax = readU32(content, pos + 8 + 8);
      pos += size;
    }

    const avcCNew = avcC ? patchAvcc(avcC) : null;
    const avgBr = Math.max(1, Math.round((totalVideoBytes * 8) / durationSec));
    const maxBr = btrtMax !== null && btrtMax > 0 ? btrtMax : avgBr;
    const btrtBody = new Uint8Array(12);
    new DataView(btrtBody.buffer).setUint32(0, 0, false);
    new DataView(btrtBody.buffer).setUint32(4, maxBr >>> 0, false);
    new DataView(btrtBody.buffer).setUint32(8, avgBr >>> 0, false);
    const btrt = buildBox('btrt', btrtBody);

    const entryBody = concat([avc1Fixed, avcCNew, colr, pasp, btrt].filter(Boolean));
    const entry = buildBox(codec, entryBody);
    return buildBox('stsd', concat([head, entry]));
  }

  function resolveSampleOffsets(chunkOffsets, sizes, stscEntries) {
    const perChunk = [];
    for (let i = 0; i < stscEntries.length; i++) {
      const fc = stscEntries[i][0];
      const spc = stscEntries[i][1];
      const last = i + 1 < stscEntries.length ? stscEntries[i + 1][0] - 1 : chunkOffsets.length;
      for (let c = fc; c <= last && c <= chunkOffsets.length; c++) perChunk[c - 1] = spc;
    }
    const sampleOffsets = [];
    let sampleIdx = 0;
    for (let c = 0; c < chunkOffsets.length; c++) {
      let off = chunkOffsets[c];
      const count = perChunk[c] || 1;
      for (let s = 0; s < count; s++) {
        sampleOffsets.push(off);
        off += sizes[sampleIdx] || 0;
        sampleIdx++;
      }
    }
    return sampleOffsets;
  }

  function inflate(inputBytes, inputView, multiplier) {
    const fileSize = inputBytes.length;
    const tops = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = tops.find((b) => b.type === 'moov');
    const mdatBox = tops.find((b) => b.type === 'mdat');
    if (!moovBox) throw new Error('Moov box not found');
    if (!mdatBox) throw new Error('Mdat box not found');

    const moovKids = children(inputBytes, inputView, moovBox);
    const mvhd = moovKids.find((b) => b.type === 'mvhd');

    const tracks = moovKids
      .filter((b) => b.type === 'trak')
      .map((trak) => analyzeTrak(inputBytes, inputView, trak, false))
      .filter(Boolean);

    const video = tracks.find((t) => handlerType(inputBytes, t.hdlr) === 'vide');
    if (!video) throw new Error('Video track not found');

    const realCount = video.sttsInfo.count;
    if (realCount === 0) throw new Error('No video samples found');
    const timescale = video.mdhdInfo.timescale || 0;
    const avgDelta = Math.round(video.sttsInfo.totalDuration / realCount);
    const realFps = timescale > 0 && avgDelta > 0 ? timescale / avgDelta : 0;

    let m = multiplier;
    if (!m || m < MIN_MULTIPLIER) {
      if (realFps > 0 && MAX_TARGET_FPS > realFps) {
        m = Math.floor(MAX_TARGET_FPS / realFps);
      } else {
        m = MAX_MULTIPLIER;
      }
      m = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, m));
    }

    const codec = video.codec;
    const padCount = realCount * (m - 1);
    const totalSamples = realCount * m;

    const rng = makeRng(hashSeed(inputBytes, Math.min(inputBytes.length, 65536)));
    const padBlocks = [];
    const padSizes = [];
    for (let i = 0; i < padCount; i++) {
      const len = PAD_MIN + (rng() % (PAD_MAX - PAD_MIN + 1));
      padBlocks.push(buildPadBlock(codec, len, rng));
      padSizes.push(len);
    }

    const isAvc = codec === 'avc1' || codec === 'avc3';
    const firstOff = video.chunkOffsets[0];
    const firstSize = video.sizes[0];
    const firstSample = inputBytes.subarray(firstOff, firstOff + firstSize);
    const newFirst = isAvc ? stripSei(firstSample) : firstSample;
    const seiRemoved = firstSample.length - newFirst.length;

    const totalVideoBytes = video.sizes.reduce((s, x) => s + x, 0) - firstSize + newFirst.length + padBlocks.reduce((s, b) => s + b.length, 0);
    const durationSec = timescale > 0 ? video.sttsInfo.totalDuration / timescale : 1;

    const newStsd = buildVideoStsd(inputBytes, inputView, video.stsd, totalVideoBytes, durationSec, codec);
    const newStts = buildStts(buildPaddedStts(realCount, avgDelta, padCount, rng));
    const newStsc = buildStsc([[1, 1, 1]]);
    const newSizes = [newFirst.length].concat(video.sizes.slice(1)).concat(padSizes);
    const newStsz = buildStsz(newSizes);

    const audioTracks = tracks.filter((t) => handlerType(inputBytes, t.hdlr) === 'soun');
    const otherTrakBoxes = tracks
      .filter((t) => handlerType(inputBytes, t.hdlr) !== 'vide' && handlerType(inputBytes, t.hdlr) !== 'soun')
      .map((t) => sliceBox(inputBytes, t.trak));

    function buildVideoTrak(videoStco) {
      const stblParts = [];
      for (const kid of video.stblKids) {
        const type = kid.type;
        if (type === 'stsd') stblParts.push(newStsd);
        else if (type === 'stts') stblParts.push(newStts);
        else if (type === 'stsc') stblParts.push(newStsc);
        else if (type === 'stsz') stblParts.push(newStsz);
        else if (type === 'stco' || type === 'co64') stblParts.push(buildStco(videoStco));
        else stblParts.push(sliceBox(inputBytes, kid));
      }
      return buildTrakFromParts(video, 'VideoHandler', buildBox('stbl', concat(stblParts)));
    }

    function buildAudioTrak(audio, audioStco, audioOpts) {
      const stblParts = [];
      for (const kid of audio.stblKids) {
        if (kid.type === 'stco' || kid.type === 'co64') stblParts.push(buildStco(audioStco));
        else if (kid.type === 'stsd' && audioOpts && audioOpts.stsd) stblParts.push(audioOpts.stsd);
        else if (kid.type === 'stts' && audioOpts && audioOpts.stts) stblParts.push(buildStts(audioOpts.stts));
        else stblParts.push(sliceBox(inputBytes, kid));
      }
      return buildTrakFromParts(audio, 'SoundHandler', buildBox('stbl', concat(stblParts)), audioOpts && audioOpts.mdhdDur);
    }

    function buildTrakFromParts(t, handlerName, stblBox, mdhdDur) {
      const mdiaKids = children(inputBytes, inputView, t.mdia);
      const minfKids = children(inputBytes, inputView, t.minf);
      const mediaHeader = minfKids.find((b) => b.type === 'vmhd' || b.type === 'smhd');
      const dinf = minfKids.find((b) => b.type === 'dinf');
      const hType = handlerName === 'VideoHandler' ? 'vide' : 'soun';

      const minfParts = [];
      if (mediaHeader) minfParts.push(sliceBox(inputBytes, mediaHeader));
      if (dinf) minfParts.push(sliceBox(inputBytes, dinf));
      minfParts.push(stblBox);

      const mdiaParts = [];
      for (const kid of mdiaKids) {
        if (kid.type === 'mdhd') mdiaParts.push(buildMdhd(sliceBox(inputBytes, kid), t.mdhdInfo.version, LANG_UND, mdhdDur));
        else if (kid.type === 'hdlr') mdiaParts.push(buildHdlr(hType, handlerName));
        else if (kid.type === 'minf') mdiaParts.push(buildBox('minf', concat(minfParts)));
        else mdiaParts.push(sliceBox(inputBytes, kid));
      }

      const trakParts = [];
      for (const kid of children(inputBytes, inputView, t.trak)) {
        if (kid.type === 'mdia') trakParts.push(buildBox('mdia', concat(mdiaParts)));
        else trakParts.push(sliceBox(inputBytes, kid));
      }
      return buildBox('trak', concat(trakParts));
    }

    const videoStcoCount = totalSamples;
    const audioStcoCounts = audioTracks.map((a) => a.chunkOffsets.length);

    const audioOpts = audioTracks.map((a) => {
      const timing = computeAudioTiming(inputBytes, inputView, a, durationSec * 1000);
      if (!timing) return null;
      const newTotal = timing.stts[0][0] * timing.stts[0][1] + timing.stts[1][0] * timing.stts[1][1];
      const oldTotal = a.sttsInfo.totalDuration;
      const oldBr = oldTotal > 0 ? Math.round((a.sizes.reduce((s, x) => s + x, 0) * 8 * timing.aTimescale) / oldTotal) : 0;
      const newBr = Math.round((timing.totalBytes * 8 * timing.aTimescale) / newTotal);
      const audioStsd = patchAudioStsd(sliceBox(inputBytes, a.stsd), oldBr, newBr);
      return { stts: timing.stts, mdhdDur: timing.mdhdDur, stsd: audioStsd };
    });

    function assembleMoov(videoStcoValues, audioStcoValues) {
      const parts = [];
      if (mvhd) parts.push(sliceBox(inputBytes, mvhd));
      parts.push(buildVideoTrak(videoStcoValues));
      let ai = 0;
      for (const a of audioTracks) {
        parts.push(buildAudioTrak(a, audioStcoValues[ai++], audioOpts[ai - 1]));
      }
      for (const other of otherTrakBoxes) parts.push(other);
      for (const kid of moovKids) {
        if (kid.type === 'mvhd' || kid.type === 'trak' || kid.type === 'udta' || kid.type === 'meta') continue;
        parts.push(sliceBox(inputBytes, kid));
      }
      parts.push(buildUdtaTag(ENCODER_KEY, ENCODER_COMMENT));
      return buildBox('moov', concat(parts));
    }

    const moovPass1 = assembleMoov(new Array(videoStcoCount).fill(0), audioTracks.map((a) => new Array(a.chunkOffsets.length).fill(0)));
    const ftyp = buildFtyp(codec === 'hvc1' || codec === 'hev1');
    const mdatDataStart = mdatBox.offset + 8;
    const firstRel = firstOff - mdatDataStart;
    const mdatBefore = inputBytes.subarray(mdatDataStart, firstOff);
    const mdatAfter = inputBytes.subarray(firstOff + firstSize, mdatBox.end);
    const newMdatData = concat([mdatBefore, newFirst, mdatAfter].concat(padBlocks));
    const newMdat = concat([u32(8 + newMdatData.length), new Uint8Array([0x6d, 0x64, 0x61, 0x74]), newMdatData]);

    const newMdatStart = ftyp.length + moovPass1.length + 8;

    const origSampleOffsets = resolveSampleOffsets(video.chunkOffsets, video.sizes, video.stscEntries);
    const videoStcoValues = [];
    for (const off of origSampleOffsets) {
      const rel = off - mdatDataStart;
      videoStcoValues.push(newMdatStart + rel - (off > firstOff ? seiRemoved : 0));
    }
    let padCursor = newMdatStart + mdatBefore.length + newFirst.length + mdatAfter.length;
    for (const blk of padBlocks) {
      videoStcoValues.push(padCursor);
      padCursor += blk.length;
    }

    const audioStcoValues = audioTracks.map((a) => {
      const values = [];
      for (const off of a.chunkOffsets) {
        const rel = off - mdatDataStart;
        values.push(rel < firstRel ? newMdatStart + rel : newMdatStart + rel - seiRemoved);
      }
      return values;
    });

    const moov = assembleMoov(videoStcoValues, audioStcoValues);
    if (moov.length !== moovPass1.length) {
      throw new Error('internal: moov size changed between passes');
    }

    const output = concat([ftyp, moov, newMdat]);
    const outBuffer = output.buffer.slice(0, output.length);
    const outBytes = new Uint8Array(outBuffer);

    return {
      buffer: outBuffer,
      bytes: outBytes,
      view: new DataView(outBuffer),
      sampleCount: totalSamples,
      realCount,
      fakeCount: padCount,
      multiplier: m,
      realFps: Math.round(realFps * 100) / 100,
      seiRemoved,
    };
  }

  /* ---------- analyze ---------- */

  function analyze(inputBytes, inputView) {
    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === 'moov');
    if (!moovBox) throw new Error('Not an MP4/MOV file (no moov box found)');

    const moovKids = children(inputBytes, inputView, moovBox);
    let video = null;
    let audio = null;
    for (const trak of moovKids.filter((b) => b.type === 'trak')) {
      const t = analyzeTrak(inputBytes, inputView, trak, false);
      if (!t) continue;
      const kind = handlerType(inputBytes, t.hdlr);
      if (kind === 'vide' && !video) {
        video = t;
      } else if (kind === 'soun' && !audio) {
        audio = t;
      }
    }
    if (!video) throw new Error('Video track not found');

    const audioCodec = audio ? (audio.codec || null) : null;

    const codec = video.codec;
    let width = 0;
    let height = 0;
    const stsdContentStart = video.stsd.offset + boxHeaderSize(video.stsd);
    if (stsdContentStart + 16 + 24 + 4 <= video.stsd.end) {
      width = inputView.getUint16(stsdContentStart + 16 + 24, false);
      height = inputView.getUint16(stsdContentStart + 16 + 24 + 2, false);
    }

    const timescale = video.mdhdInfo.timescale || 0;
    const mediaDuration = video.mdhdInfo.duration || 0;
    const realCount = video.sttsInfo.count;
    const totalDuration = video.sttsInfo.totalDuration;

    const durationSec = timescale > 0 ? (mediaDuration || totalDuration) / timescale : 0;
    const fps = durationSec > 0 && realCount > 0 ? realCount / durationSec : 0;
    const bitrateMbps = durationSec > 0 ? (fileSize * 8) / durationSec / 1e6 : 0;

    const editorBoxes = scanEditorFingerprint(inputBytes, inputView, moovBox);
    const editor = editorBoxes.length === 0 ? 'none'
      : (editorBoxes.some((t) => t === 'mebx' || t === 'scpt') ? 'capcut' : 'editor-unknown');

    return {
      codec,
      width,
      height,
      fps: Math.round(fps * 100) / 100,
      durationSec: Math.round(durationSec * 1000) / 1000,
      frameCount: realCount,
      bitrateMbps: Math.round(bitrateMbps * 100) / 100,
      fileSize,
      editor,
      editorBoxes,
      audioCodec,
    };
  }

  /* ---------- preserve (metadata-only timescale claim - ut0ku direction) ---------- */
  /* Inflates the movie + video timescales so the file CLAIMS a much higher fps than  */
  /* it actually has (60 -> claims 120, 120 -> claims 480). TikTok's encoder reads the */
  /* claimed fps and applies a less aggressive frame-rate reduction strategy, so the   */
  /* real 60/120fps content stays sharp. Durations stay untouched (everything stays    */
  /* tick-consistent - the claim doubles because seconds = ticks / timescale), and the */
  /* audio track is completely untouched. No sample tables or frame data are changed.  */

  function patchTsOnly(outBytes, outView, box, multiplier, patched) {
    const hs = boxHeaderSize(box);
    const cs = box.offset + hs;
    const version = outBytes[cs] & 0xff;
    let tsOff;
    if (version === 0) tsOff = cs + 12;
    else if (version === 1) tsOff = cs + 20;
    else return false;
    if (tsOff + 4 > box.end) return false;

    const oldTs = outView.getUint32(tsOff, false);
    if (oldTs === 0) return false;
    const newTs = oldTs * multiplier;
    if (newTs > 0xffffffff) return false;
    outView.setUint32(tsOff, newTs, false);
    patched.push({ type: box.type, field: 'timescale', timescale: [oldTs, newTs] });
    return true;
  }

  function preserve(inputBytes, inputView, sourceFps) {
    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === 'moov');
    if (!moovBox) throw new Error('Not an MP4/MOV file (no moov box found)');

    const fps = Number(sourceFps) || 0;
    let multiplier = 0;
    if (fps >= 59 && fps <= 61) multiplier = 2;
    else if (fps >= 119 && fps <= 121) multiplier = 4;
    else throw new Error('Unsupported source fps ' + fps + ' - only 60 or 120 fps sources are supported (ut0ku timescale method)');

    const outBuffer = new ArrayBuffer(fileSize);
    const outBytes = new Uint8Array(outBuffer);
    outBytes.set(inputBytes);
    const outView = new DataView(outBuffer);

    const patched = [];

    const moovKids = children(outBytes, outView, moovBox);
    const mvhd = moovKids.find((b) => b.type === 'mvhd');
    if (!mvhd) throw new Error('No mvhd box found');
    patchTsOnly(outBytes, outView, mvhd, multiplier, patched);

    for (const trak of moovKids.filter((b) => b.type === 'trak')) {
      const trakKids = children(outBytes, outView, trak);
      const mdia = trakKids.find((b) => b.type === 'mdia');
      if (!mdia) continue;
      const mdiaKids = children(outBytes, outView, mdia);
      const hdlr = mdiaKids.find((b) => b.type === 'hdlr');
      const mdhd = mdiaKids.find((b) => b.type === 'mdhd');
      if (!mdhd) continue;
      const hType = hdlr ? handlerType(outBytes, hdlr) : '';
      if (hType === 'vide') {
        patchTsOnly(outBytes, outView, mdhd, multiplier, patched);
      }
    }

    if (patched.length === 0) throw new Error('Nothing to patch - no video time boxes found');

    return {
      buffer: outBuffer,
      bytes: outBytes,
      view: outView,
      divider: multiplier,
      multiplier,
      sourceFps: fps,
      claimedFps: Math.round(fps * multiplier),
      patched,
      sampleCount: 0,
      realCount: 0,
      fakeCount: 0,
    };
  }

  /* ---------- exports ---------- */

  function createPatcher() {
    return {
      inflate,
      preserve,
      analyze,
      normalize: normalizeContainer,
      parseBoxes,
      constants: { MAX_TARGET_FPS, MAX_MULTIPLIER, MIN_MULTIPLIER },
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = createPatcher();
  } else if (typeof self !== 'undefined') {
    self.TTO_INFLATE = createPatcher();
  }
})();
