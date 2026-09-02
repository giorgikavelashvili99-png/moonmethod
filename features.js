(function () {
  'use strict';

  function $id(id) { return document.getElementById(id); }

  var API = null;
  try { API = window.__PREX_API; } catch (e) {}

  var ACCENTS = { overview: 'overview', optimize: 'upload', check: 'check', extension: 'extension', pricing: 'pricing', guide: 'guide' };

  function syncAccent(name) {
    var a = ACCENTS[name] || 'overview';
    document.documentElement.dataset.accent = a;
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.tab') : null;
    if (t && t.dataset && t.dataset.tab) syncAccent(t.dataset.tab);
  });
  (function accentOnLoad() {
    var saved = null;
    try { saved = sessionStorage.getItem('prex-tab'); } catch (e) {}
    if (!saved) {
      var act = document.querySelector('.tab.active');
      if (act && act.dataset) saved = act.dataset.tab;
    }
    syncAccent(saved || 'overview');
  })();

  function fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function timeAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  /* ================================================================ */
  /* FEATURE 1 · Export settings assistant                             */
  /* ================================================================ */
  var EXPORT = {
    capcut: {
      label: 'CapCut',
      rows: [
        ['Where', 'CapCut PC: File → Export (Ctrl+E). CapCut mobile: Export (top-right).'],
        ['Container', 'MP4 — do not pick MOV for TikTok post files.'],
        ['Codec', 'H.264 / AVC (CapCut default) — keep it, do not switch to H.265.'],
        ['Audio', 'AAC · 192–256 kbps · 48 kHz.'],
      ],
    },
    davinci: {
      label: 'DaVinci Resolve',
      rows: [
        ['Where', 'Deliver page → Add job → Custom (not "Same as timeline").'],
        ['Format', 'MP4 · video codec H.264 (H.265 is not ideal — TikTok re-encodes to H.264 anyway).'],
        ['Audio', 'Codec AAC · 192–256 kbps · 48 kHz.'],
      ],
    },
    premiere: {
      label: 'Premiere Pro',
      rows: [
        ['Where', 'Export Media (Ctrl+M) → Format: H.264.'],
        ['Preset', 'Start from "Match Source — High bitrate" then tune the numbers below.'],
        ['Audio', 'AAC · 192–256 kbps · 48 kHz.'],
      ],
    },
    filmora: {
      label: 'Wondershare Filmora',
      rows: [
        ['Where', 'Export → Video tab → Format MP4.'],
        ['Codec', 'H.264 · hardware encoding OFF for maximum TikTok compatibility.'],
        ['Audio', 'AAC · 192–256 kbps · 48 kHz.'],
      ],
    },
    phone: {
      label: 'Phone editor (iPhone / Android)',
      rows: [
        ['Export', 'Phone editors hide the codec — just export at your target resolution & fps.'],
        ['Transfer', 'Move the file to your PC via USB cable or cloud drive. NEVER chat-app / Messenger — they recompress and destroy the optimization.'],
        ['Upload', 'Upload from the PC browser (tiktok.com/upload or TikTok Studio web).'],
      ],
    },
  };

  var TARGETS = {
    '1080p60': {
      label: '1080p · 60 fps',
      res: '1920×1080',
      fps: '60 fps (constant)',
      bitrate: '8–12 Mbps (VBR, high)',
      note: 'Sweet spot for TikTok — the served player tag should read 1080P/60.',
    },
    '1080p120': {
      label: '1080p · 120 fps',
      res: '1920×1080',
      fps: '120 fps (constant, keeps 60fps player tag)',
      bitrate: '12–16 Mbps (VBR, high)',
      note: 'Source 120fps gives TikTok the best headroom — player tag stays 1080P/60.',
    },
    '4k60': {
      label: '4K · 60 fps',
      res: '3840×2160',
      fps: '60 fps (constant)',
      bitrate: '20–28 Mbps (VBR, high)',
      note: 'TikTok serves max 1080p — 4K only buys headroom for their encoder. Files get big; keep a fast connection.',
    },
  };

  function renderExport() {
    var edSel = $id('g-editor');
    var tgSel = $id('g-target');
    var panel = $id('g-panel');
    var lines = $id('g-lines');
    if (!edSel || !tgSel || !panel || !lines) return;
    var ed = EXPORT[edSel.value] || EXPORT.capcut;
    var tg = TARGETS[tgSel.value] || TARGETS['1080p60'];
    var rows = [
      ['Resolution', tg.res],
      ['Frame rate', tg.fps],
      ['Video bitrate', tg.bitrate],
      ['Codec', 'H.264 / AVC (High profile)'],
      ['Audio', 'AAC · 192–256 kbps · 48 kHz'],
      ['Container', 'MP4 (H.264 + AAC)'],
    ].concat(ed.rows);
    lines.innerHTML = rows.map(function (r) {
      return '<div class="gl-row"><span class="gl-k">' + esc(r[0]) + '</span><span class="gl-v">' + esc(r[1]) + '</span></div>';
    }).join('') + '<div class="gl-note">' + esc(tg.note) + '</div>';
    panel.classList.remove('hidden');
  }

  function copyExport() {
    var edSel = $id('g-editor');
    var tgSel = $id('g-target');
    if (!edSel || !tgSel) return;
    var ed = EXPORT[edSel.value] || EXPORT.capcut;
    var tg = TARGETS[tgSel.value] || TARGETS['1080p60'];
    var text = 'PREX export settings — ' + ed.label + ' · ' + tg.label +
      '\nResolution: ' + tg.res +
      '\nFrame rate: ' + tg.fps +
      '\nVideo bitrate: ' + tg.bitrate +
      '\nCodec: H.264 / AVC (High profile)' +
      '\nAudio: AAC 192–256 kbps 48 kHz' +
      '\nContainer: MP4 (H.264 + AAC)';
    var done = function () {
      var c = $id('g-copied');
      if (c) { c.classList.remove('hidden'); setTimeout(function () { c.classList.add('hidden'); }, 2500); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e) { done(); }
    }
  }

  var IE = $id('g-editor');
  if (IE) IE.addEventListener('change', renderExport);
  var IT = $id('g-target');
  if (IT) IT.addEventListener('change', renderExport);
  var GC = $id('g-copy');
  if (GC) GC.addEventListener('click', copyExport);
  renderExport();

  /* ================================================================ */
  /* FEATURE 2 · How to upload steps (done state)                      */
  /* ================================================================ */
  var STEPS_KEY = 'prex-guide-steps';
  var stepState = {};
  try { stepState = JSON.parse(localStorage.getItem(STEPS_KEY) || '{}'); } catch (e) { stepState = {}; }

  function saveSteps() {
    try { localStorage.setItem(STEPS_KEY, JSON.stringify(stepState)); } catch (e) {}
  }

  function wireSteps() {
    var list = $id('gsteps');
    if (!list) return;
    list.querySelectorAll('.gstep').forEach(function (st) {
      var idx = st.getAttribute('data-step');
      var head = st.querySelector('.gstep-head');
      var toggle = st.querySelector('.gstep-toggle');
      var body = st.querySelector('.gstep-body');
      var chk = st.querySelector('.gstep-done input');
      if (stepState[idx]) st.classList.add('done');
      if (head && body) head.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('.gstep-done')) return;
        body.classList.toggle('closed');
      });
      if (toggle && body) toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        body.classList.toggle('closed');
      });
      if (chk) chk.addEventListener('change', function () {
        stepState[idx] = chk.checked;
        st.classList.toggle('done', !!chk.checked);
        saveSteps();
      });
    });
  }
  wireSteps();

  /* ================================================================ */
  /* FEATURE 3 · Upload readiness score (from info-grid)               */
  /* ================================================================ */
  var RD_CARD = $id('readiness-card');
  var RD_GRID = $id('info-grid');
  var INFO_CARD = $id('info-card');

  function labelFor(s, p, w, i) {
    return { ok: esc(s), warn: '⚠ ' + esc(w), info: '💡 ' + esc(i) }[p] || esc(s);
  }

  function readinessChip(text, status, kind) {
    return '<span class="rd-chip ' + status + '">' + text + '</span>';
  }

  function renderReadiness() {
    if (!RD_CARD || !RD_GRID) return;
    var cells = RD_GRID.querySelectorAll('.info-cell');
    if (!cells.length || (INFO_CARD && INFO_CARD.classList.contains('hidden'))) {
      RD_CARD.classList.add('hidden');
      return;
    }
    var row = {};
    cells.forEach(function (c) {
      var k = c.querySelector('.k');
      var v = c.querySelector('.v');
      if (k && v) row[k.textContent.trim()] = v.textContent.trim();
    });

    var chips = [];
    var passes = 0;
    var total = 0;
    var warnings = [];

    var codec = (row['Codec'] || '').toLowerCase();
    total++;
    if (/avc1|h264/.test(codec)) { passes++; chips.push(readinessChip('Codec: H.264/AVC — PREX ready', 'ok')); }
    else if (/hvc1|hev1|hevc/.test(codec)) { chips.push(readinessChip('Codec: HEVC/H.265 — re-encode converts to clean H.264', 'warn')); warnings.push('HEVC source'); }
    else if (/av01|av1/.test(codec)) { chips.push(readinessChip('Codec: AV1 — use re-encode mode for TikTok-safe H.264', 'warn')); warnings.push('AV1 source'); }
    else { chips.push(readinessChip('Codec: ' + (row['Codec'] || 'unknown'), 'info')); }

    var res = row['Resolution'] || '';
    var resM = String(res).match(/(\d+)\s*x\s*(\d+)/);
    total++;
    if (resM) {
      var w = parseInt(resM[1], 10), h = parseInt(resM[2], 10);
      var wide = Math.max(w, h), small = Math.min(w, h);
      if (wide >= 2560) { chips.push(readinessChip('Resolution: ' + res + ' (4K — TikTok serves max 1080p)', 'ok')); passes++; }
      else if (wide >= 1920) { chips.push(readinessChip('Resolution: ' + res + ' — full HQ', 'ok')); passes++; }
      else if (wide >= 1280) { chips.push(readinessChip('Resolution: ' + res + ' — OK, 1080p export recommended', 'info')); passes++; }
      else if (small > 400) { chips.push(readinessChip('Resolution: ' + res + ' — below 1080p, re-export if possible', 'warn')); warnings.push('low resolution'); }
      else { chips.push(readinessChip('Resolution: ' + res + ' — very small', 'warn')); warnings.push('low resolution'); }
    } else { chips.push(readinessChip('Resolution: ' + (res || '?'), 'info')); }

    var fps = parseFloat(row['Frame rate']) || 0;
    total++;
    if (fps === 120) { chips.push(readinessChip('Frame rate: 120 fps — ideal, player tag 1080P/60', 'ok')); passes++; }
    else if (fps === 60) { chips.push(readinessChip('Frame rate: 60 fps — ideal', 'ok')); passes++; }
    else if (fps >= 30) { chips.push(readinessChip('Frame rate: ' + fps + ' fps — fine, 60/120 scores better', 'info')); passes++; }
    else if (fps > 0) { chips.push(readinessChip('Frame rate: ' + fps + ' fps — deliver constant 60/120', 'warn')); warnings.push('low frame rate'); }
    else { chips.push(readinessChip('Frame rate: ' + (row['Frame rate'] || '?'), 'info')); }

    var dur = parseFloat(row['Duration']) || 0;
    total++;
    if (dur <= 0) { chips.push(readinessChip('Duration: ' + (row['Duration'] || '?'), 'info')); }
    else if (dur <= 600) { chips.push(readinessChip('Duration: ' + Math.round(dur) + ' s — fine', 'ok')); passes++; }
    else if (dur <= 3600) { chips.push(readinessChip('Duration: ' + Math.round(dur / 60) + ' min — long file, upload from PC on a stable connection', 'info')); passes++; }
    else { chips.push(readinessChip('Duration: over 1 hour — risk of upload cutoffs', 'warn')); warnings.push('very long video'); }

    var bm = parseFloat(row['Bitrate']) || 0;
    total++;
    if (bm <= 0) { chips.push(readinessChip('Bitrate: ' + (row['Bitrate'] || '?'), 'info')); }
    else if (bm >= 2.5 && bm <= 30) { chips.push(readinessChip('Bitrate: ' + bm.toFixed(1) + ' Mbps — healthy', 'ok')); passes++; }
    else if (bm < 2.5) { chips.push(readinessChip('Bitrate: ' + bm.toFixed(1) + ' Mbps — low, may look soft after TikTok re-encode', 'warn')); warnings.push('low bitrate'); }
    else { chips.push(readinessChip('Bitrate: ' + bm.toFixed(1) + ' Mbps — very high, big upload; TikTok caps served bitrate anyway', 'info')); }

    var frames = parseInt(row['Frames'], 10);
    if (!isNaN(frames)) { chips.push(readinessChip('Frames: ' + frames.toLocaleString('en-US'), 'info')); }

    RD_CARD.querySelector('#rd-chips').innerHTML = chips.join('');
    var score = total > 0 ? Math.round(10 * passes / total) : 0;
    var sc = $id('rd-score');
    var vd = $id('rd-verdict');
    if (sc) {
      sc.textContent = score + '/10';
      sc.className = 'rd-score' + (score >= 8 ? ' ok' : score >= 6 ? ' warn' : ' bad');
    }
    if (vd) {
      var verdict;
      if (score >= 8 && !warnings.length) verdict = 'Ready — TikTok should serve full resolution with your target fps. Upload from a PC browser and keep "Allow high-quality uploads" ON.';
      else if (score >= 6) verdict = 'Mostly good — ' + warnings.join(', ') + '. Consider a new export from your editor for the best result.';
      else verdict = 'Needs work — ' + (warnings.join(', ') || 'check the chips above') + '. Re-export from your editor, then run the Optimizer.';
      vd.textContent = verdict;
    }
    RD_CARD.classList.remove('hidden');
  }

  if (RD_GRID) {
    var rdTimer = null;
    var rdObs = new MutationObserver(function () {
      clearTimeout(rdTimer);
      rdTimer = setTimeout(renderReadiness, 140);
    });
    rdObs.observe(RD_GRID, { childList: true, subtree: true, characterData: true });
    if (INFO_CARD) {
      var infoObs = new MutationObserver(function () {
        clearTimeout(rdTimer);
        rdTimer = setTimeout(renderReadiness, 140);
      });
      infoObs.observe(INFO_CARD, { attributes: true, attributeFilter: ['class'] });
    }
    renderReadiness();

    /* auto-flip guide editor when CapCut metadata is detected */
    var edOb = new MutationObserver(function () {
      var cells = RD_GRID.querySelectorAll('.info-cell');
      var isCapCut = false;
      cells.forEach(function (c) {
        var k = c.querySelector('.k');
        var v = c.querySelector('.v');
        if (k && v && /editor/i.test(k.textContent) && /capcut/i.test(v.textContent)) isCapCut = true;
      });
      if (isCapCut && IE && IE.value !== 'capcut') {
        IE.value = 'capcut';
        renderExport();
      }
    });
    edOb.observe(RD_GRID, { childList: true, subtree: true, characterData: true });
  }

  /* ================================================================ */
  /* FEATURE 5b · One-tap presets                                      */
  /* ================================================================ */
  var PRESETS = {
    standard: { mode: 'method', remux: false, upscale2k: false, encodeQuality: 'faster' },
    normalize: { mode: 'normalize', remux: true, upscale2k: false },
    cinematic: { mode: 'reencode', remux: false, upscale2k: false, encodeQuality: 'sharper' },
    gaming: { mode: 'reencode', remux: false, upscale2k: false, encodeQuality: 'faster' },
  };

  function readOptions() {
    var mode = $id('mode'), remux = $id('remux'), up = $id('upscale2k'), q = $id('encode-quality');
    return {
      mode: mode ? mode.value : '',
      remux: remux ? !!remux.checked : false,
      upscale2k: up ? !!up.checked : false,
      encodeQuality: q ? q.value : '',
    };
  }

  function currentPresetName() {
    var o = readOptions();
    for (var k in PRESETS) {
      var p = PRESETS[k];
      if (p.mode === o.mode && p.remux === o.remux && (p.upscale2k === undefined || p.upscale2k === o.upscale2k) && (p.encodeQuality === undefined || p.encodeQuality === o.encodeQuality)) return k;
    }
    return 'custom';
  }

  function setControl(el, val, isCheck) {
    if (!el) return;
    if (isCheck ? el.checked === val : el.value === val) return;
    if (isCheck) el.checked = val; else el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applyPreset(name) {
    var p = PRESETS[name];
    if (!p) return;
    setControl($id('mode'), p.mode, false);
    if (p.remux !== undefined) setControl($id('remux'), p.remux, true);
    if (p.upscale2k !== undefined) setControl($id('upscale2k'), p.upscale2k, true);
    if (p.encodeQuality !== undefined) setControl($id('encode-quality'), p.encodeQuality, false);
    refreshPresetChips();
  }

  function refreshPresetChips() {
    var chips = document.querySelectorAll('#preset-chips .pchip');
    var active = currentPresetName();
    chips.forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-preset') === active);
    });
  }

  var chipsBox = $id('preset-chips');
  if (chipsBox) {
    chipsBox.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.pchip') : null;
      if (!btn) return;
      if (btn.getAttribute('data-preset') === 'custom') {
        toastChip('Current options are saved automatically — tweak the Options card.');
        return;
      }
      applyPreset(btn.getAttribute('data-preset'));
    });
  }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'mode' || t.id === 'remux' || t.id === 'upscale2k' || t.id === 'encode-quality' || t.id === 'multiplier' || t.id === 'autoopt') refreshPresetChips();
  });
  refreshPresetChips();

  function toastChip(msg) {
    var t = document.createElement('div');
    t.className = 'fx-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 400);
    }, 2600);
  }

  /* ================================================================ */
  /* FEATURE 5a · Batch queue (max 5, 1 usage per file)                */
  /* ================================================================ */
  var MAX_BATCH = 5;
  var queue = [];
  var running = false;

  var Q_CARD = $id('queue-card');
  var Q_LIST = $id('queue-list');
  var Q_COUNT = $id('q-count');
  var Q_CLEAR = $id('q-clear');
  var Q_HINT = $id('q-hint');

  function qRefs() {
    if (!Q_CARD) Q_CARD = $id('queue-card');
    if (!Q_LIST) Q_LIST = $id('queue-list');
    if (!Q_COUNT) Q_COUNT = $id('q-count');
    if (!Q_CLEAR) Q_CLEAR = $id('q-clear');
    if (!Q_HINT) Q_HINT = $id('q-hint');
  }

  function renderQueue() {
    qRefs();
    if (!Q_LIST) return;
    var STATUS_LABEL = { queued: 'Queued', processing: 'Processing…', done: 'Done', err: 'Failed', limit: 'Usage limit' };
    Q_LIST.innerHTML = queue.map(function (item) {
      return '<div class="q-row q-' + item.status + '">' +
        '<span class="q-name" title="' + esc(item.file.name) + '">' + esc(item.file.name) + '</span>' +
        '<span class="q-size">' + fmtBytes(item.file.size) + '</span>' +
        '<span class="q-dot"></span>' +
        '<span class="q-status">' + (item.err ? esc(item.err) : (STATUS_LABEL[item.status] || item.status)) + '</span>' +
        '</div>';
    }).join('');
    if (Q_COUNT) Q_COUNT.textContent = queue.length + '/' + MAX_BATCH;
    if (Q_CLEAR) Q_CLEAR.classList.toggle('hidden', queue.length === 0);
    if (Q_CARD) Q_CARD.classList.toggle('hidden', queue.length === 0);
  }

  function addToQueue(files) {
    qRefs();
    var room = MAX_BATCH - queue.length;
    var accepted = files.slice(0, Math.max(0, room));
    var dropped = files.length - accepted.length;
    accepted.forEach(function (f) {
      queue.push({ file: f, status: 'queued', err: null });
    });
    renderQueue();
    if (dropped > 0 && Q_HINT) {
      var old = Q_HINT.textContent;
      Q_HINT.textContent = 'Max 5 files per batch — dropped ' + dropped + ' (queue full). Each file uses 1 usage.';
      setTimeout(function () { if (Q_HINT) Q_HINT.textContent = old; }, 6000);
    }
    if (accepted.length && !running) runQueue();
  }

  function usageBlocked() {
    return fetch('api/me', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        var u = j && j.usage;
        return !!(u && !u.unlimited && u.limit > 0 && u.used >= u.limit);
      })
      .catch(function () { return false; });
  }

  async function runQueue() {
    qRefs();
    if (running) return;
    running = true;
    var autoEl = $id('autoopt');
    var autoPrev = autoEl ? autoEl.checked : false;
    if (autoEl && autoPrev) {
      autoEl.checked = false;
      autoEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    try {
      while (true) {
        var item = queue.find(function (x) { return x.status === 'queued'; });
        if (!item) break;
        item.status = 'processing';
        item.err = null;
        renderQueue();
        try {
          if (!API || !API.onFile || !API.process) {
            item.status = 'err';
            item.err = 'PREX API not available';
            renderQueue();
            break;
          }
          await API.onFile(item.file);
          if (API.getFile && API.getFile() !== item.file) {
            item.status = 'err';
            item.err = 'file rejected (maintenance?)';
            renderQueue();
            continue;
          }
          var pb = $id('process-btn');
          if (!pb || pb.disabled) {
            if (pb && pb.classList.contains('hidden')) {
              item.status = 'done';
              item.err = null;
              renderQueue();
              if (await usageBlocked()) {
                queue.forEach(function (x) { if (x.status === 'queued') { x.status = 'limit'; x.err = null; } });
                renderQueue();
                break;
              }
              continue;
            }
            item.status = 'err';
            item.err = 'could not read video';
            renderQueue();
            continue;
          }
          await API.process();
          var doneBtn = $id('done-btn');
          var ok = doneBtn && !doneBtn.classList.contains('hidden');
          if (ok) {
            item.status = 'done';
            renderQueue();
            if (await usageBlocked()) {
              queue.forEach(function (x) { if (x.status === 'queued') { x.status = 'limit'; x.err = null; } });
              renderQueue();
              break;
            }
          } else {
            item.status = 'err';
            item.err = 'optimization failed';
            renderQueue();
          }
        } catch (err) {
          item.status = 'err';
          item.err = String(err && err.message || err).slice(0, 60);
          renderQueue();
        }
      }
    } finally {
      running = false;
      if (autoEl && autoEl.checked !== autoPrev) {
        autoEl.checked = autoPrev;
        autoEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      var leftover = queue.filter(function (x) { return x.status === 'queued'; }).length;
      if (!leftover && Q_HINT) Q_HINT.textContent = 'Drop up to 5 videos at once — each file uses 1 usage and is processed one by one, right in your browser.';
      if (autoEl && autoPrev) refreshPresetChips();
    }
  }

  if (Q_CLEAR) Q_CLEAR.addEventListener('click', function () {
    queue = [];
    renderQueue();
  });

  window.addEventListener('drop', function (e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    var files = Array.prototype.slice.call(dt.files);
    var videos = files.filter(function (f) {
      return /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name);
    });
    if (!videos.length) return;
    if (videos.length > 1 || running || queue.length > 0) {
      e.stopPropagation();
      e.preventDefault();
      var ov = $id('drag-overlay');
      if (ov) ov.classList.remove('show');
      addToQueue(videos);
    }
  }, true);

  /* ================================================================ */
  /* FEATURE 4 · Recent checks (history + verdict)                     */
  /* ================================================================ */
  var HIST_KEY = 'prex-check-history';
  var recent = [];
  try { recent = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { recent = []; }
  if (!Array.isArray(recent)) recent = [];

  function saveHist() {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(recent.slice(0, 8))); } catch (e) {}
  }

  function vidId(url) {
    var m = String(url).match(/\/video\/(\d+)/);
    return m ? m[1] : (String(url).match(/tiktok\.com\/@[\w.-]+\/(\d+)/) || [])[1] || null;
  }

  function encodeUrl(url) {
    try { return encodeURIComponent(url); } catch (e) { return ''; }
  }

  function renderRecent() {
    var card = $id('recent-checks-card');
    var box = $id('recent-checks');
    if (!card || !box) return;
    if (!recent.length) { card.classList.add('hidden'); return; }
    box.innerHTML = recent.map(function (r) {
      var badgeCls = r.tier === '4K' ? 't4k' : r.tier === '2K' ? 't2k' : r.tier === '1080p' ? 't1080' : r.tier === '720p' ? 't720' : 'tsd';
      var verdict = r.good
        ? '<span class="v-good">Full quality ✓</span>'
        : r.mid
          ? '<span style="color:var(--yellow);font-weight:600">Good (720p)</span>'
          : '<span class="v-bad">Downscaled — check this one</span>';
      return '<div class="rc-row" data-id="' + esc(r.id) + '" data-url="' + esc(r.url) + '">' +
        '<div class="rc-main"><span class="rc-url">' + esc(r.url) + '</span>' +
        '<span class="rc-meta"><span class="check-badge ' + badgeCls + '">' + esc(r.tier || '?') + '</span> ' +
        esc(r.res || '') + ' · ' + esc(r.bitrate || '') + ' · <span class="rc-time">' + timeAgo(r.at) + '</span></span></div>' +
        '<span class="rc-verdict">' + verdict + '</span>' +
        '<button class="rc-recheck" type="button" title="Re-check">↻</button>' +
        '</div>';
    }).join('');
    card.classList.remove('hidden');
  }

  var CHK_RESULT = $id('check-result');
  if (CHK_RESULT) {
    var chkTimer = null;
    var chkObs = new MutationObserver(function () {
      clearTimeout(chkTimer);
      chkTimer = setTimeout(function () {
        var grid = CHK_RESULT.querySelector('.check-grid');
        if (!grid) return;
        var cells = grid.querySelectorAll('.info-cell');
        var row = {};
        cells.forEach(function (c) {
          var k = c.querySelector('.k');
          var v = c.querySelector('.v');
          if (k && v) row[k.textContent.trim()] = v.textContent.trim();
        });
        var served = row['Served at'] || '';
        var badge = '';
        var bm = null;
        var servedM = served.match(/^(\d+)x(\d+)/);
        cells.forEach(function (c) {
          var k = c.querySelector('.k');
          if (k && k.textContent.indexOf('Served') === 0) {
            var b = c.querySelector('.check-badge');
            if (b) badge = b.textContent.trim();
          }
        });
        if (servedM) {
          var w = parseInt(servedM[1], 10), h = parseInt(servedM[2], 10);
          var tier = Math.max(w, h) >= 2160 ? '4K' : Math.max(w, h) >= 1440 ? '2K' : Math.max(w, h) >= 1080 ? '1080p' : Math.max(w, h) >= 720 ? '720p' : 'SD';
          var bitM = String(row['Video bitrate'] || '').match(/([\d.]+)\s*Mbps/);
          var urlInput = $id('check-url');
          var url = urlInput ? urlInput.value.trim() : '';
          var entry = {
            id: vidId(url) || '?',
            url: url,
            tier: tier,
            res: servedM[1] + 'x' + servedM[2],
            bitrate: bitM ? bitM[1] + ' Mbps' : '',
            at: Date.now(),
            good: tier === '1080p' || tier === '2K' || tier === '4K',
            mid: tier === '720p',
          };
          recent = recent.filter(function (x) { return x.id !== entry.id; });
          recent.unshift(entry);
          saveHist();
          renderRecent();
        }
      }, 160);
    });
    chkObs.observe(CHK_RESULT, { childList: true, subtree: true });
  }

  document.addEventListener('click', function (e) {
    var re = e.target && e.target.closest ? e.target.closest('.rc-recheck') : null;
    if (!re) return;
    var row = re.closest('.rc-row');
    var input = $id('check-url');
    var btn = $id('check-btn');
    if (row && input && btn) {
      var url = row.getAttribute('data-url') || '';
      input.value = url;
      btn.click();
    }
  });
  var rcClear = $id('rc-clear');
  if (rcClear) rcClear.addEventListener('click', function () {
    recent = [];
    saveHist();
    renderRecent();
  });
  renderRecent();
})();