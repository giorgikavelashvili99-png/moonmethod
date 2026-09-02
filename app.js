(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const P = window.TTO_INFLATE;
  if (!P) throw new Error('inflate.js failed to load');
  const PX = window.TTO_PREX;
  if (!PX) throw new Error('prex.js failed to load');

  let currentFile = null;
  let currentResult = null;
  let sourceInfo = null;
  let resultUrl = null;
  let busy = false;

  /* ---------- client-side error capture (remote diagnostics) ---------- */
  function postClientLog(msg) {
    try {
      fetch('api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'msg=' + encodeURIComponent(String(msg).slice(0, 1800)),
        credentials: 'same-origin',
        keepalive: true,
      }).catch(function () {});
    } catch (e) { /* silent */ }
  }
  window.addEventListener('error', (e) => {
    postClientLog('onerror: ' + (e && e.message ? e.message : String(e)) + ' @ ' + (e && e.filename ? e.filename : '') + ':' + (e && e.lineno ? e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    postClientLog('unhandledrejection: ' + (r && r.message ? r.message : String(r)));
  });

  /* ---------- settings persistence ---------- */
  const SETTINGS_KEY = 'prex-settings';
  let settings = {};
  function loadSettings() {
    try {
      settings = Object.assign({}, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
    } catch (e) {
      settings = {};
    }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }
  function applySetting(id, key, kind) {
    const el = $('' + id);
    if (!el) return;
    const has = settings[key] !== undefined && settings[key] !== null && settings[key] !== '';
    if (kind === 'bool') { if (typeof settings[key] === 'boolean') el.checked = settings[key]; }
    else if (has) el.value = settings[key];
    el.addEventListener('change', () => {
      settings[key] = kind === 'bool' ? el.checked : el.value;
      saveSettings();
    });
  }
  loadSettings();

  function resetResultCard() {
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
    const v = $('result-video');
    if (v) { v.pause(); v.removeAttribute('src'); }
    $('result-card').classList.add('hidden');
  }

  /* ---------- action bar / live progress ---------- */
  const bar = $('action-bar');
  const barFill = $('ab-fill');
  const barPct = $('ab-pct');
  const barStage = $('ab-stage');
  const MODE_LABELS = { prex: 'PREX Method', normalize: 'Normalize', reencode: 'Re-encode', patch: 'Inflate (legacy)' };
  let ffProgHook = null;

  function setProgress(pct, label, state) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    barFill.classList.remove('indet', 'ok', 'err');
    if (state) barFill.classList.add(state);
    barFill.style.width = (state === 'indet' ? '34%' : v + '%');
    barPct.textContent = state === 'indet' ? '...' : v + '%';
    if (label != null) barStage.textContent = label;
    if (engineActive && typeof engineTrack === 'function') engineTrack(v, label);
  }
  function barBusy(on) { bar.classList.toggle('busy', on); }
  function updateModeChip() {
    $('ab-mode').textContent = MODE_LABELS[$('mode').value] || $('mode').value;
    $('ab-mode').dataset.mode = $('mode').value;
  }
  function collapseCard(bodyId, toggleId, collapsed) {
    $('' + bodyId).classList.toggle('closed', collapsed);
    $('' + toggleId).classList.toggle('collapsed', collapsed);
    if (bodyId === 'options-body' || bodyId === 'checklist-body') {
      settings['collapse-' + bodyId] = collapsed;
      saveSettings();
    }
  }
  function toggleCard(bodyId, toggleId) {
    collapseCard(bodyId, toggleId, !$('' + bodyId).classList.contains('closed'));
  }

  /* ---------- icons / toasts ---------- */
  const ICONS = {
    check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    alert: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
    info: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8.5h.01"/></svg>',
    x: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    arrow: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m0 0-6-6m6 6-6 6"/></svg>',
  };
  function toast(type, msg) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    const ic = type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info';
    el.innerHTML = '<span class="t-icon">' + ICONS[ic] + '</span><span class="t-text"></span><button class="t-close" aria-label="Dismiss">' + ICONS.x + '</button>';
    el.querySelector('.t-text').textContent = msg;
    const box = $('toasts');
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    const kill = () => {
      if (el.classList.contains('out')) { el.remove(); return; }
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    };
    el.querySelector('.t-close').addEventListener('click', kill);
    setTimeout(kill, type === 'err' ? 8000 : 5000);
  }

  /* ---------- PREX ENGINE panel ---------- */
  const ENGINE_LABELS = {
    prex: ['Analyzing video', 'Optimizing container', 'Preserving frame rate', 'Finalizing output'],
    normalize: ['Analyzing video', 'Cleaning container', 'Preserving frame rate', 'Finalizing output'],
    reencode: ['Analyzing video', 'Re-encoding video', 'Preserving frame rate', 'Finalizing output'],
    patch: ['Analyzing video', 'Injecting sample table', 'Preserving frame rate', 'Finalizing output'],
    tscale: ['Analyzing video', 'Normalizing timescales', 'Preserving streams', 'Finalizing output'],
    method: ['Analyzing container', 'Audio-clone signal (lossless)', 'Sanitizing signatures', 'Assembling output'],
  };
  const ENGINE_STEPS = [[0, 52], [52, 90], [90, 96], [96, 101]];
  let engineActive = false;
  function engineShow(mode) {
    engineActive = true;
    const labels = ENGINE_LABELS[mode] || ENGINE_LABELS.prex;
    const rows = $('engine-rows').children;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      r.className = 'eg-row';
      r.querySelector('.eg-label').textContent = labels[i] || '';
      r.querySelector('.eg-detail').textContent = '';
      r.querySelector('.eg-pct').textContent = '';
      r.querySelector('.eg-icon').innerHTML = '';
      let barEl = r.querySelector('.eg-bar');
      if (!barEl) {
        barEl = document.createElement('span');
        barEl.className = 'eg-bar';
        barEl.innerHTML = '<i></i>';
        r.appendChild(barEl);
      }
      barEl.querySelector('i').style.width = '0%';
    }
    $('engine-dot').className = 'engine-dot';
    $('engine-card').classList.remove('hidden');
  }
  function engineTrack(pct, detail) {
    if (!engineActive) return;
    let idx = 3;
    for (let i = 0; i < ENGINE_STEPS.length; i++) {
      if (pct >= ENGINE_STEPS[i][0] && pct < ENGINE_STEPS[i][1]) idx = i;
    }
    const rows = $('engine-rows').children;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i < idx) {
        r.classList.add('done'); r.classList.remove('active', 'fail');
        r.querySelector('.eg-icon').innerHTML = ICONS.check;
        r.querySelector('.eg-pct').textContent = '';
      } else if (i === idx) {
        r.classList.remove('done', 'fail'); r.classList.add('active');
        r.querySelector('.eg-icon').innerHTML = '';
        r.querySelector('.eg-pct').textContent = pct > 0 ? Math.round(pct) + '%' : '';
        if (detail) r.querySelector('.eg-detail').textContent = detail;
        const barEl = r.querySelector('.eg-bar');
        if (barEl) {
          const s = ENGINE_STEPS[idx];
          const span = s[1] - s[0];
          const local = span > 0 ? Math.max(0, Math.min(1, (pct - s[0]) / span)) : 0;
          barEl.querySelector('i').style.width = Math.round(local * 100) + '%';
        }
      } else {
        r.classList.remove('done', 'active', 'fail');
        r.querySelector('.eg-icon').innerHTML = '';
        r.querySelector('.eg-pct').textContent = '';
        const barEl = r.querySelector('.eg-bar');
        if (barEl) barEl.querySelector('i').style.width = '0%';
      }
    }
  }
  function engineFinish(ok) {
    engineActive = false;
    const rows = $('engine-rows').children;
    for (const r of rows) {
      r.classList.remove('active');
      if (ok) {
        r.classList.add('done');
        r.querySelector('.eg-icon').innerHTML = ICONS.check;
        r.querySelector('.eg-pct').textContent = '100%';
      } else if (!r.classList.contains('done') && !r.classList.contains('fail')) {
        r.classList.add('fail');
        r.querySelector('.eg-icon').innerHTML = ICONS.x;
      }
    }
    $('engine-dot').className = 'engine-dot ' + (ok ? 'done' : 'err');
  }
  function engineHide() { engineActive = false; $('engine-card').classList.add('hidden'); }

  /* ---------- ffmpeg (clean remux) ---------- */
  const FFMPEG_BASE = new URL('.', location.href).href;
  const FFMPEG_MT = {
    coreURL: FFMPEG_BASE + 'ffmpeg-core.js',
    wasmURL: FFMPEG_BASE + 'ffmpeg-core.wasm',
    workerURL: FFMPEG_BASE + 'ffmpeg-core.worker.js',
  };
  const FFMPEG_ST = {
    coreURL: FFMPEG_BASE + 'ffmpeg-core-st.js',
    wasmURL: FFMPEG_BASE + 'ffmpeg-core-st.wasm',
  };
  let ffmpeg = null;
  let ffmpegPromise = null;
  let ffmpegLogTail = [];

  function pushFfmpegLog(message) {
    if (typeof message !== 'string' || !message.trim()) return;
    ffmpegLogTail.push(message.trim());
    if (ffmpegLogTail.length > 40) ffmpegLogTail.shift();
  }

  function ffmpegErrorHint() {
    return ffmpegLogTail.slice(-5).join(' | ');
  }

  async function ensureFFmpeg() {
    if (ffmpeg) return ffmpeg;
    if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) {
      throw new Error('ffmpeg.js failed to load - run "node server.js" and open http://localhost:3000 (direct file:// opens block the worker)');
    }
    if (ffmpegPromise) return ffmpegPromise;
    ffmpegPromise = (async () => {
      const f = new window.FFmpegWASM.FFmpeg();
      f.on('log', ({ type, message }) => {
        pushFfmpegLog(message);
        if (typeof message === 'string' && /error|failed|no such file|unknown|invalid/i.test(message)) logLine('err', 'ffmpeg: ' + message);
      });
      let ffLastPct = -1;
      f.on('progress', ({ progress, time }) => {
        if (typeof progress === 'number' && progress > 0 && progress <= 1) {
          if (ffProgHook) ffProgHook(progress);
          const pct = Math.round(progress * 100);
          if (pct % 10 === 0 && pct !== ffLastPct) {
            ffLastPct = pct;
            logLine('', (time ? 'ffmpeg re-encode ' : 'ffmpeg remux ') + pct + '%');
          }
        }
      });
      try {
        await f.load(FFMPEG_MT);
        logLine('', '> ffmpeg core: multithread (fast path)');
      } catch (e1) {
        try {
          await f.load(FFMPEG_ST);
          logLine('warn', '> ffmpeg core: single-thread fallback - encodes will be slower (enable SharedArrayBuffer: modern Chrome/Edge/Firefox/Desktop Safari)');
        } catch (e2) {
          ffmpegPromise = null;
          throw new Error('ffmpeg core failed to load (MT: ' + (e1 && e1.message ? e1.message : e1) + ') (ST: ' + (e2 && e2.message ? e2.message : e2) + ')');
        }
      }
      ffmpeg = f;
      return f;
    })();
    return ffmpegPromise;
  }

  // Warm-up: preload the ffmpeg core in the background after the page settles,
  // so the first Optimize click starts instantly instead of waiting for the core.
  // FFmpeg WASM is lazy-loaded on demand (Forge/reencode mode only).
  // No auto-warm-up: saves 31MB download + WASM init for Method mode.


  async function readResult(f, outName) {
    const raw = await f.readFile(outName);
    const arr = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const buf = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    try {
      await f.deleteFile('input.mp4');
      await f.deleteFile(outName);
    } catch (e) {
      /* ignore cleanup errors */
    }
    return { buf, bytes: new Uint8Array(buf) };
  }

  async function cleanRemux(bytes) {
    const f = await ensureFFmpeg();
    ffmpegLogTail = [];
    logLine('', '> Running ffmpeg clean remux (faststart + metadata scrub)...');
    await f.writeFile('input.mp4', bytes);
    try {
      await f.exec(['-hide_banner', '-nostdin', '-i', 'input.mp4', '-c', 'copy', '-movflags', '+faststart', '-map_metadata', '-1', '-sn', 'out.mp4']);
    } catch (e) {
      throw new Error('ffmpeg remux failed: ' + ffmpegErrorHint());
    }
    return readResult(f, 'out.mp4');
  }

  function roundFps(fps) {
    const f = Number(fps) || 0;
    if (f >= 59.5 && f <= 60.5) return 60;
    if (f >= 118 && f <= 122) return 120;
    if (f >= 47.5 && f <= 48.5) return 48;
    if (f >= 29.5 && f <= 30.5) return 30;
    if (f >= 24.9 && f <= 25.1) return 25;
    if (f >= 23.9 && f <= 24.1) return 24;
    return f > 0 ? Math.round(f) : 0;
  }

  async function highQualityReencode(bytes, info, upscale2k, quality, codec) {
    const f = await ensureFFmpeg();
    ffmpegLogTail = [];
    const useHevc = codec === 'libx265';
    const enc = quality === 'faster' ? { crf: '23', preset: 'veryfast' } : { crf: '18', preset: 'medium' };
    logLine('', '> PREX Forge re-encode (' + (useHevc ? 'HEVC hvc1' : 'H.264 High@4.2') + ', 10-12Mbps sweet spot, 60fps CFR, CRF ' + enc.crf + ')...');
    if (info && info.durationSec > 120) {
      logLine('warn', '> Video is ~' + Math.round(info.durationSec) + ' s long - the encode may take several minutes. Wait time does not change the output quality; the settings already fix the quality.');
    }

    const w = Number(info.width) || 0;
    const h = Number(info.height) || 0;
    const portrait = h > w;
    const maxDim = Math.max(w, h);
    const targetFps = 60;
    logLine('', '> source ' + (w || '?') + 'x' + (h || '?') + ' @ ' + (info.fps ? info.fps + ' fps' : '?')
      + ' -> locked at 60 fps CFR (CompressBase recipe: prevents TikTok FPS drop)');

    let vf = null;
    if (upscale2k && maxDim > 0 && maxDim < 2160) {
      vf = portrait ? 'scale=1440:-2:flags=lanczos' : 'scale=-2:1440:flags=lanczos';
      logLine('', '> upscaling to 2K (' + (portrait ? '1440x2560' : '2560x1440') + ') - slower, sharper on TikTok');
    } else if (maxDim > 1920) {
      vf = portrait ? 'scale=1080:-2:flags=lanczos' : 'scale=-2:1080:flags=lanczos';
      logLine('', '> source ' + w + 'x' + h + ' above 1080p - downscaled to compliance (1080x1920 class): bitrate stays under TikTok threshold = stream-copy treatment');
    }
    vf = vf ? vf + ',deblock=filter=strong,unsharp=5:5:0.8,eq=saturation=1.08:contrast=1.02' : 'deblock=filter=strong,unsharp=5:5:0.8,eq=saturation=1.08:contrast=1.02';

    const fpsArgs = targetFps ? ['-r', String(targetFps), '-fps_mode', 'cfr'] : [];

    const h264Spec = ['-c:v', 'libx264', '-crf', enc.crf, '-preset', enc.preset, '-profile:v', 'high', '-level', '4.2', '-b:v', '10M', '-maxrate', '12M', '-bufsize', '24M'];
    const hevcSpec = ['-c:v', 'libx265', '-crf', enc.crf, '-preset', enc.preset, '-x265-params', 'no-sao=1:deblock=1,1:keyint=250:min-keyint=25', '-tag:v', 'hvc1'];
    let effHevc = useHevc;
    const mkBase = () => ['-hide_banner', '-nostdin', '-i', 'input.mp4',
      ...(effHevc ? hevcSpec : h264Spec), '-pix_fmt', 'yuv420p'];
    // Audio: clean AAC 192k re-encode (verified CompressBase recipe).
    const audioArgs = ['-c:a', 'aac', '-b:a', '256k'];
    const tail = [
      ...audioArgs,
      '-movflags', '+faststart', '-map_metadata', '-1', '-sn',
      '-max_muxing_queue_size', '1024',
    ];

    await f.writeFile('input.mp4', bytes);
    let usedPreset = '';
    const attempts = [];
    if (useHevc) attempts.push('hevc');
    attempts.push('h264');
    let encoded = false;
    for (const att of attempts) {
      const spec = att === 'hevc' ? hevcSpec : h264Spec;
      effHevc = att === 'hevc';
      const mk = () => mkBase();
      try {
        await f.exec(mk().concat(['-vf', vf], tail, fpsArgs, ['out.mp4']));
        usedPreset = 'crf' + enc.crf + ' ' + enc.preset + ' + forge chain [' + (effHevc ? 'HEVC hvc1' : 'H.264') + ']';
        encoded = true; break;
      } catch (e1) {
        logLine('err', '> [' + (effHevc ? 'HEVC' : 'H.264') + '] encode with filters failed: ' + ffmpegErrorHint());
      }
      try {
        await f.exec(mk().concat(tail, fpsArgs, ['out.mp4']));
        usedPreset = 'crf' + enc.crf + ' ' + enc.preset + ' (no filters) [' + (effHevc ? 'HEVC hvc1' : 'H.264') + ']';
        encoded = true; break;
      } catch (e2) {
        logLine('err', '> [' + (effHevc ? 'HEVC' : 'H.264') + '] encode without filters failed: ' + ffmpegErrorHint());
      }
    }
    if (!encoded) {
      logLine('err', '> all encode paths failed - falling back to stream copy - no quality change');
      await f.exec(['-hide_banner', '-nostdin', '-i', 'input.mp4', '-c', 'copy', '-movflags', '+faststart', '-map_metadata', '-1', '-sn', 'out.mp4']);
      usedPreset = 'stream copy (fallback)';
    }
    const out = await readResult(f, 'out.mp4');
    try {
      const chk = P.analyze(out.bytes, new DataView(out.buffer));
      logLine('ok', '> output verified: ' + (chk.width || '?') + 'x' + (chk.height || '?') + ' @ ' + (chk.fps ? chk.fps.toFixed(1) + ' fps' : '?') + ' / ' + (chk.durationSec ? chk.durationSec.toFixed(2) + ' s' : '?'));
      if (targetFps && roundFps(chk.fps) === targetFps) {
        logLine('ok', '> ' + targetFps + ' fps kept (verified) - TikTok player tag should read 1080P/' + (targetFps === 120 ? '60' : targetFps) + ' or higher');
      } else if (targetFps) {
        logLine('err', '> WARNING: output is ' + (chk.fps ? chk.fps.toFixed(1) : '?') + ' fps, expected ' + targetFps + ' - upload may get re-timed by TikTok');
      }
    } catch (e) {
      logLine('err', '> WARNING: encoded output could not be parsed (' + e.message + ') - upload may fail');
    }
    out.usedPreset = usedPreset;
    return out;
  }

  /* ---------- tabs (persisted across refresh) ---------- */
  function moveTabPill() {
    const pill = $('tab-pill');
    const tabsEl = $('tabs');
    const active = tabsEl && tabsEl.querySelector('.tab.active');
    if (!pill || !active) return;
    pill.style.width = active.offsetWidth + 'px';
    pill.style.transform = 'translateX(' + (active.offsetLeft - 5) + 'px)';
  }
  function activateTab(name) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    document.querySelectorAll('.pane').forEach((x) => x.classList.toggle('active', x.id === 'pane-' + name));
    const heroBlock = $('hero-' + name);
    if (heroBlock) {
      document.querySelectorAll('.hero-block').forEach((b) => b.classList.remove('active'));
      heroBlock.classList.add('active');
    }
    if (name === 'check') updateCheckHint();
    moveTabPill();
  }
  window.addEventListener('resize', () => moveTabPill());
  document.addEventListener('DOMContentLoaded', () => setTimeout(moveTabPill, 60));
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      sessionStorage.setItem('prex-tab', t.dataset.tab);
      activateTab(t.dataset.tab);
    });
  });
  (function restoreTab() {
    const saved = sessionStorage.getItem('prex-tab');
    if (saved && document.getElementById('pane-' + saved)) activateTab(saved);
  })();

  function onServer() { return /^https?:$/.test(location.protocol); }
  function updateCheckHint() {
    const hint = $('check-server-hint');
    if (hint) hint.style.display = onServer() ? 'none' : '';
  }
  updateCheckHint();

  /* ---------- dropzone / file picker ---------- */
  const dz = $('dropzone');
  const fileInput = $('file-input');

  dz.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) onFile(fileInput.files[0]);
  });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => {
    e.stopPropagation();
    hideDragOverlay();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) onFile(f);
  });

  /* ---------- drag anywhere ---------- */
  const dragOverlay = $('drag-overlay');
  let dragDepth = 0;
  function hideDragOverlay() {
    dragDepth = 0;
    dragOverlay.classList.remove('show');
  }
  function hasAnyFiles(e) {
    if (!e.dataTransfer || !e.dataTransfer.types) return false;
    for (let i = 0; i < e.dataTransfer.types.length; i++) {
      if (e.dataTransfer.types[i] === 'Files') return true;
    }
    return false;
  }
  window.addEventListener('dragenter', (e) => {
    if (!hasAnyFiles(e)) return;
    dragDepth++;
    dragOverlay.classList.add('show');
  });
  window.addEventListener('dragover', (e) => {
    if (hasAnyFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasAnyFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragOverlay.classList.remove('show');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    hideDragOverlay();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) onFile(f);
  });
  window.addEventListener('dragend', () => hideDragOverlay());

  /* ---------- touch / haptics ---------- */
  const isTouch = ('ontouchstart' in window) || !!(navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
  if (isTouch) {
    document.body.classList.add('is-touch');
    const sub = $('dz-sub');
    if (sub) sub.innerHTML = 'Tap to choose &middot; MP4 / MOV &middot; <b>H.264 + AAC</b> ideal';
  }
  $('choose-btn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {} }

  /* ---------- mode-dependent UI ---------- */
  const MODE_HINTS = { normalize: 'normalize-hint', reencode: 'reencode-hint', method: 'method-hint' };
  function syncModeUI() {
    const mode = $('mode').value;
    const codecRowEl = $('codec-row'); if (codecRowEl) codecRowEl.style.display = mode === 'reencode' ? '' : 'none';
    $('upscale-row').style.display = mode === 'reencode' ? '' : 'none';
    $('quality-row').style.display = mode === 'reencode' ? '' : 'none';
    for (const [m, id] of Object.entries(MODE_HINTS)) {
      $('' + id).style.display = m === mode ? '' : 'none';
    }
    updateModeChip();
  }
  $('mode').addEventListener('change', syncModeUI);
  applySetting('mode', 'mode', 'str');
  applySetting('remux', 'remux', 'bool');
  applySetting('multiplier', 'multiplier', 'str');
  applySetting('upscale2k', 'upscale2k', 'bool');
  applySetting('encode-quality', 'encodeQuality', 'str');
  applySetting('autoopt', 'autoOpt', 'bool');
  syncModeUI();

  /* ---------- collapsible cards ---------- */
  function wireCollapse(headId, bodyId, toggleId) {
    $('' + toggleId).addEventListener('click', (e) => { e.stopPropagation(); toggleCard(bodyId, toggleId); });
    $('' + headId).addEventListener('click', () => toggleCard(bodyId, toggleId));
  }
  wireCollapse('options-head', 'options-body', 'options-toggle');
  wireCollapse('checklist-head', 'checklist-body', 'checklist-toggle');
  if (settings['collapse-options-body'] === false) collapseCard('options-body', 'options-toggle', false);
  if (settings['collapse-checklist-body'] === false) collapseCard('checklist-body', 'checklist-toggle', false);

  /* ---------- process ---------- */
  $('process-btn').addEventListener('click', process);

  async function onFile(file) {
    if (maintOn) {
      logLine('err', 'The studio is in maintenance mode right now. Try again later.');
      toast('err', 'The studio is in maintenance mode right now. Try again later.');
      return;
    }
    if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v)$/i.test(file.name)) {
      logLine('err', 'Unsupported file type. Choose an MP4 or MOV video.');
      toast('err', 'Unsupported file type. Choose an MP4 or MOV video.');
      return;
    }
    currentFile = file;
    currentResult = null;
    sourceInfo = null;
    hideReportCard();
    resetResultCard();
    $('download-btn').classList.add('hidden');
    $('done-btn').classList.add('hidden');
    $('another-btn').classList.add('hidden');
    $('result-stats').classList.add('hidden');
    $('log-card').classList.add('hidden');
    $('process-btn').classList.remove('hidden');
    $('process-btn').disabled = true;
    bar.classList.remove('visible');
    engineHide();

    clearLog();
    logLine('ok', 'file loaded: ' + file.name + ' (' + fmtBytes(file.size) + ')');
    $('ab-file').textContent = file.name + ' · ' + fmtBytes(file.size);

    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const info = P.analyze(bytes, new DataView(buf));
      sourceInfo = info;
      renderInfo(info);
      logLine('', 'container parsed: ' + (info.codec || 'unknown') + ' / ' + (info.width || '?') + 'x' + (info.height || '?') + ' @ ' + (info.fps ? info.fps.toFixed(1) + ' fps' : '?'));
      $('process-btn').disabled = false;
      bar.classList.add('visible');
      collapseCard('options-body', 'options-toggle', true);
      collapseCard('checklist-body', 'checklist-toggle', true);
      const dzEl = $('dropzone');
      dzEl.classList.add('captured');
      setTimeout(() => dzEl.classList.remove('captured'), 1600);
      toast('ok', 'Video loaded - ' + fmtBytes(file.size) + ' ready');
      if (settings.autoOpt) setTimeout(() => { if (currentFile && !busy) process(); }, 450);
    } catch (err) {
      logLine('err', 'Could not read video: ' + err.message);
      $('info-card').classList.add('hidden');
      $('process-btn').disabled = true;
      bar.classList.remove('visible');
      toast('err', 'Could not read video: ' + err.message);
    }
  }

  function renderInfo(info) {
    $('info-grid').innerHTML = [
      ['Codec', info.codec || 'unknown'],
      ['Resolution', info.width && info.height ? info.width + 'x' + info.height : '?'],
      ['Frame rate', info.fps ? info.fps.toFixed(2) + ' fps' : '?'],
      ['Duration', info.durationSec ? info.durationSec.toFixed(2) + ' s' : '?'],
      ['Bitrate', info.bitrateMbps ? info.bitrateMbps.toFixed(1) + ' Mbps' : '?'],
      ['Size', fmtBytes(info.fileSize)],    ].map(([k, v]) => '<div class="info-cell"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');
    $('info-card').classList.remove('hidden');
  }

  function countUp(el, to, suffix, done) {
    const dur = 750;
    const t0 = performance.now();
    const fmt = (v) => v.toLocaleString('en-US');
    function tick(t) {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(to * e)) + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else if (done) done();
    }
    requestAnimationFrame(tick);
  }

  function renderResultCard(out) {
    let outInfo = null;
    const modeNow = $('mode').value;
    if (modeNow === 'reencode' || modeNow === 'patch') {
      try {
        outInfo = P.analyze(out.bytes, new DataView(out.buffer, out.byteOffset || 0, out.buffer.byteLength));
      } catch (e) {
        outInfo = null;
      }
    } else if (sourceInfo) {
      // prex / normalize / remux keep the video stats byte-identical - reuse them.
      outInfo = Object.assign({}, sourceInfo, { fileSize: out.bytes.length });
    }
    const s = sourceInfo;
    const num = (v) => (v === null || v === undefined) ? '?' : v;
    const rows = [
      ['Resolution', s && s.width ? s.width + 'x' + s.height : '?', outInfo && outInfo.width ? outInfo.width + 'x' + outInfo.height : '?'],
      ['Frame rate', s && s.fps ? s.fps.toFixed(2) + ' fps' : '?', outInfo && outInfo.fps ? outInfo.fps.toFixed(2) + ' fps' : '?'],
      ['Frames', s ? num(s.frameCount) : '?', outInfo ? num(outInfo.frameCount) : '?'],
      ['Size', fmtBytes(currentFile.size), fmtBytes(out.bytes.length)],
      ['Duration', s && s.durationSec ? s.durationSec.toFixed(2) + ' s' : '?', outInfo && outInfo.durationSec ? outInfo.durationSec.toFixed(2) + ' s' : '?'],
    ];
    $('result-grid').innerHTML = rows.map(([k, a, b]) =>
      '<div class="r-cell"><div class="k">' + k + '</div><div class="pair"><span class="before">' + a + '</span><span class="arrow">' + ICONS.arrow + '</span><span class="after">' + b + '</span></div></div>'
    ).join('');
    if (outInfo) {
      const cells = $('result-grid').querySelectorAll('.r-cell .after');
      if (cells[2] && outInfo.frameCount) countUp(cells[2], outInfo.frameCount, '');
      if (cells[3]) {
        const nB = out.bytes.length;
        countUp(cells[3], nB, ' B', () => { cells[3].textContent = fmtBytes(nB); });
      }
    }
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(new Blob([out.bytes], { type: 'video/mp4' }));
    $('result-video').src = resultUrl;
    $('result-card').classList.remove('hidden');
    $('result-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---------- tier entitlement gate ---------- */
  function denyGate(message) {
    logLine('err', '> BLOCKED: ' + message);
    engineFinish(false);
    setProgress(0, 'Blocked', 'err');
    toast('err', message);
    buzz([60, 100, 60]);
    return false;
  }
  async function gateBlock() {
    if (!currentFile) return true;
    let ent = null;
    try {
      const r = await fetch('api/me', { cache: 'no-store', credentials: 'same-origin' });
      ent = await r.json();
    } catch (e) { ent = null; }
    if (!ent || !ent.ok) return denyGate('Could not verify your account rights. Sign in again.');
    if (ent.secBlocked) return denyGate(ent.secError || 'Your account was flagged by the Fair Play Shield and can\'t optimize right now. Message the admin.');
    if (ent.secRestricted) {
      logLine('warn', '> Fair Play Shield: temporarily capped at Member limits (1080p / 60fps) — ' + (ent.secYoung ? 'your Discord account is under 14 days old. It unlocks automatically after that.' : 'flagged for review, contact the admin to sort it out.'));
    }
    if (ent.owner) return true;
    if (ent.maintenance && ent.maintenance.on) {
      return denyGate(ent.maintenance.msg || 'The studio is under maintenance / being patched right now. We\'ll be back shortly.');
    }
    if (!ent.discord) return true; // access pass — owner-managed, exempt
    if (ent.tier !== 'member' && ent.tier !== 'booster' && ent.tier !== 'vip' && ent.tier !== 'promoter') {
      if (ent.tier === 'unknown') {
        return denyGate('Role check is failing on the server. Try again in a moment — if it persists, contact the admin.');
      }
      return denyGate('No active tier role found. Join the Discord server and take the Member role first.');
    }
    const q = ent.quality;
    if (q && q.maxDim && sourceInfo && (sourceInfo.width > q.maxDim || sourceInfo.height > q.maxDim)) {
      return denyGate('Your tier supports up to 1080p. VIP unlocks 4K.');
    }
    if (q && q.maxFps && sourceInfo && sourceInfo.fps > q.maxFps) {
      return denyGate('Your tier supports up to 60fps. VIP unlocks 120fps.');
    }
    const uk = ent.usage;
    if (uk && !uk.unlimited && uk.used >= uk.limit) {
      return denyGate('Weekly usage limit reached (' + uk.limit + '/week). Auto-resets every Monday 12AM (Manila time).');
    }
    return true;
  }

  async function process() {
    if (busy || !currentFile) return;
    busy = true;
    hideReportCard();
    resetResultCard();
    $('process-btn').disabled = true;
    $('download-btn').classList.add('hidden');
    $('done-btn').classList.add('hidden');
    $('result-stats').classList.add('hidden');
    $('log-card').classList.remove('hidden');
    $('mode').disabled = true;
    $('clear-btn').disabled = true;
    barBusy(true);
    setProgress(0, 'Analyzing source...');
    let stageBase = 4;
    const patchPrexWithProgress = (b) =>
      PX.patchPrex(b, { multiplier: 5, onProgress: (p, label) => setProgress(stageBase + p * (90 - stageBase), label || 'Applying PREX signal...') });

    const mode = $('mode').value;
    const remux = $('remux').checked;
    const multRaw = $('multiplier').value;
    const mult = multRaw === 'auto' ? undefined : Number(multRaw);
    engineShow(mode);

    try {
      if (!(await gateBlock())) return;
      logLine('', '> System ready for optimization...');
    if (navigator.brave) logLine('warn', '> Brave browser detected - for fastest processing, try Chrome or Edge');
      if (mode === 'prex' && sourceInfo && (sourceInfo.codec === 'hvc1' || sourceInfo.codec === 'hev1')) {
        throw new Error('This video uses HEVC/H.265. The PREX Method needs H.264/AVC. Switch mode to PREX Forge (ffmpeg) and it converts to a clean H.264 master with no quality loss.');
      }
      const rawBuf = currentFile.buffer ? currentFile.buffer : await currentFile.arrayBuffer();
      let bytes = new Uint8Array(rawBuf);
      let buf = rawBuf;

      if (remux && mode === 'normalize') {
        ffProgHook = (p) => setProgress(8 + p * 44, 'Remuxing container...');
        const clean = await cleanRemux(bytes);
        ffProgHook = null;
        buf = clean.buf;
        bytes = clean.bytes;
        const info = P.analyze(bytes, new DataView(buf));
        renderInfo(info);
        setProgress(52, 'Container ready');
        stageBase = 52;
        logLine('ok', '> clean remux complete: ' + fmtBytes(bytes.length) + ' (moov first, editor metadata stripped)');
      }

      logLine('', mode === 'patch'
        ? '> Running binary AST patcher (sample table injection)...'
        : mode === 'prex'
          ? '> Running PREX container patch (byte-identical video)...'
          : mode === 'reencode'
            ? '> High-quality re-encode (no remux pass - the encode already writes a clean container)...'
            : (remux ? '> Clean remux only (no injection).' : '> Running faststart normalization...'));

      const t0 = performance.now();
      let out;
      if (mode === 'method') {
        setProgress(4, 'Analyzing container (signal engine)...');
        logLine('', '> PREX Method: processing (lossless)...');
        if (!currentFile) throw new Error('No file loaded');
        if (!window.KryptonaepMP4) throw new Error('Kuronai engine failed to load - hard refresh (Ctrl+F5) and retry.');
        let result;
        const procStart = Date.now();
        const procTimer = setInterval(() => {
          const elapsed = Math.round((Date.now() - procStart) / 1000);
          setProgress(50, 'Still processing... ' + elapsed + 's elapsed (lossless patch)');
        }, 5000);
        try {
          result = await window.KryptonaepMP4.process(currentFile, (pct, label, detail) => {
            clearInterval(procTimer);
            setProgress(Math.max(2, Math.min(96, pct)), label + (detail ? ' ? ' + detail : ''));
          });
        } catch (eEng) {
          if (/AAC\/mp4a/i.test(eEng.message || '')) {
            throw new Error('PREX Method needs an AAC audio track (CapCut MP4 exports are ideal). Switch to PREX Forge - it re-encodes any input to a compliant master.');
          }
          throw eEng;
        } finally {
          clearInterval(procTimer);
        }
        const engAb = await result.blob.arrayBuffer();
        out = { buffer: engAb, bytes: new Uint8Array(engAb), multiplier: 1, sampleCount: 0, realCount: 0 };
        setProgress(97, 'Audio-clone signal complete');
        logLine('ok', '> PREX Method applied - optimization complete');
      } else if (mode === 'reencode') {
        const info = P.analyze(bytes, new DataView(buf));
        ffProgHook = (p) => setProgress(52 + p * 38, 'Re-encoding video...');
        const codecEl = $('forge-codec');
        const enc = await highQualityReencode(bytes, info, $('upscale2k').checked, $('encode-quality').value, codecEl ? codecEl.value : 'libx265');
        ffProgHook = null;
        setProgress(90, 'Encode complete');
        out = { buffer: enc.buf, bytes: enc.bytes, multiplier: 1, sampleCount: 0, realCount: 0 };
        logLine('ok', '> re-encoded [' + enc.usedPreset + '], ' + Math.round(info.fps) + ' fps kept - sharper master for TikTok');
      } else if (mode === 'tscale') {
        setProgress(30, 'Normalizing timescales...');
        const tsRes = PX.patchTimescale(bytes);
        out = { buffer: tsRes.buffer, bytes: tsRes.bytes, multiplier: 1, sampleCount: 0, realCount: 0 };
        setProgress(70, 'Timescales normalized');
        logLine('ok', '> PREX Timescale applied: ' + tsRes.report.normalizedAtoms + ' headers normalized to ' + tsRes.report.targetTimescale + ' - media streams byte-identical');
        if (sourceInfo) renderInfo(Object.assign({}, sourceInfo, { fileSize: out.bytes.length }));
      } else if (mode === 'prex') {
        let report;
        try {
          out = patchPrexWithProgress(bytes);
          report = out.report;
        } catch (e1) {
          logLine('err', '> direct patch failed (' + e1.message + ') - stream-copying container first (no quality loss, retry)...');
          ffProgHook = (p) => setProgress(8 + p * 44, 'Remuxing container...');
          const clean = await cleanRemux(bytes);
          ffProgHook = null;
          bytes = clean.bytes;
          buf = clean.buf;
          const info = P.analyze(bytes, new DataView(buf));
          renderInfo(info);
          stageBase = 52;
          try {
            out = patchPrexWithProgress(bytes);
            report = out.report;
            logLine('ok', '> PREX patch applied after stream-copy remux');
          } catch (e2) {
            throw new Error('PREX patch failed: ' + e2.message + ' (H.264/AVC video + AAC audio required - for HEVC/MOV sources use re-encode mode)');
          }
        }
        logLine('ok', '> PREX Method applied - optimization complete');
      } else if (mode === 'patch') {
        setProgress(80, 'Writing optimized container...');
        try {
          out = P.inflate(bytes, new DataView(buf));
        } catch (e1) {
          logLine('err', '> direct inflate failed (' + e1.message + ') - stream-copying container first (retry)...');
          ffProgHook = (p) => setProgress(8 + p * 44, 'Remuxing container...');
          const clean = await cleanRemux(bytes);
          ffProgHook = null;
          bytes = clean.bytes;
          buf = clean.buf;
          try {
            out = P.inflate(bytes, new DataView(buf));
          } catch (e2) {
            throw new Error('inflate failed: ' + e2.message);
          }
        }
      } else if (remux) {
        setProgress(90, 'Container written');
        out = { buffer: buf, bytes, multiplier: 1, sampleCount: 0, realCount: 0 };
      } else {
        setProgress(80, 'Writing optimized container...');
        const norm = P.normalize(bytes, new DataView(buf));
        if (!norm.valid) throw new Error('normalize: unsupported container');
        out = {
          buffer: norm.newBuffer || buf,
          bytes: norm.newBytes,
          multiplier: 1,
          sampleCount: 0,
          realCount: 0,
        };
        // Normalize rewrites the container: verify the output still parses.
        // If anything is off, fall back to a stream-copy remux (ffmpeg -c copy)
        // so the user is never handed a broken file.
        if (norm.changed) {
          try {
            const chk = P.analyze(out.bytes, new DataView(out.buffer));
            if (!chk || !chk.frameCount) throw new Error('output rejected');
          } catch (ve) {
            logLine('warn', '> normalize verify failed (' + ve.message + ') - falling back to stream-copy remux');
            ffProgHook = (p) => setProgress(8 + p * 44, 'Remuxing container...');
            const clean = await cleanRemux(bytes);
            ffProgHook = null;
            buf = clean.buf;
            bytes = clean.bytes;
            out = { buffer: clean.buf, bytes: clean.bytes, multiplier: 1, sampleCount: 0, realCount: 0 };
          }
        }
      }
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

      if (mode === 'prex' && out) {
        // Zero-loss proof runs in the background: the UI is never blocked by it.
        const frameCount = sourceInfo && sourceInfo.frameCount ? sourceInfo.frameCount : 0;
        if (frameCount > 60000) {
          logLine('warn', '> zero-loss verify skipped (large video, ' + frameCount + ' frames)');
        } else {
          (async () => {
            try {
              const vz = PX.verifyOutput(bytes, out.bytes);
              logLine('ok', '> verified: ' + vz.videoSampleCount + ' real video samples intact, +' + vz.ghostFrames + ' signals, audio ' + vz.audioSampleCount + ' samples untouched');
            } catch (ve) {
              logLine('err', '> zero-loss verification failed: ' + ve.message);
            }
          })();
        }
      }

      currentResult = out;
      setProgress(95, 'Verifying output...');

      if (mode === 'patch') {
        logLine('ok', '> frame density applied: x' + out.multiplier + ' (' + out.sampleCount + ' samples total)');
        const info = P.analyze(out.bytes, new DataView(out.buffer, out.byteOffset || 0, out.buffer.byteLength));
        renderInfo(info);
      } else if (mode === 'prex') {
        logLine('ok', '> PREX Method applied - ready for upload');
        logLine('ok', '> handler signatures normalized (VideoHandler/SoundHandler, lang und) - safe for strict players, same duration');
        if (sourceInfo) renderInfo(Object.assign({}, sourceInfo, { fileSize: out.bytes.length }));
      } else if (mode === 'reencode') {
        const info = P.analyze(out.bytes, new DataView(out.buffer, out.byteOffset || 0, out.buffer.byteLength));
        renderInfo(info);
      } else {
        logLine('ok', remux ? '> clean remux only - container canonicalized by FFmpeg (editor provenance stripped).' : '> container normalized (moov moved before mdat, ftyp -> isom)');
      }
      logLine('ok', '> OPTIMIZATION COMPLETE in ' + elapsed + ' s');

      $('result-stats').textContent = 'source: ' + fmtBytes(currentFile.size) + '  →  result: ' + fmtBytes(out.bytes.length);
      $('result-stats').classList.remove('hidden');
      $('download-btn').classList.remove('hidden');
      $('process-btn').classList.add('hidden');
      $('done-btn').classList.remove('hidden');
      $('another-btn').classList.remove('hidden');
      setProgress(100, 'Complete', 'ok');
      engineFinish(true);
      setTimeout(engineHide, 3000);
      renderResultCard(out);
      toast('ok', 'Optimization complete in ' + elapsed + ' s');
      trackUpload(out.bytes.length, out);
      showReportCard(out);
      buzz(55);
    } catch (err) {
      logLine('err', '> OPTIMIZATION FAILED: ' + err.message);
      engineFinish(false);
      setProgress(0, 'Failed', 'err');
      toast('err', 'Optimization failed: ' + err.message);
      buzz([40, 60, 40]);
    } finally {
      busy = false;
      ffProgHook = null;
      $('process-btn').disabled = false;
      $('mode').disabled = false;
      $('clear-btn').disabled = false;
      barBusy(false);
    }
  }

  /* ---------- activity tracking ---------- */
  function trackUpload(size, out) {
    try {
      var w = 0, h = 0;
      try {
        if (out) {
          const info = P.analyze(out.bytes, new DataView(out.buffer, out.byteOffset || 0, out.buffer.byteLength));
          w = info.width || 0;
          h = info.height || 0;
        }
      } catch (e) { /* resolution is optional */ }
      fetch('api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'event=optimize&size=' + (Math.round(Number(size) || 0)) + '&w=' + (w || 0) + '&h=' + (h || 0),
        credentials: 'same-origin',
        keepalive: true,
      })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok) {
              var msg = (j && j.error) || 'Upload tracking failed (' + r.status + ')';
              toast('err', msg);
              console.warn('trackUpload:', r.status, msg);
              if (r.status === 401) {
                setTimeout(function () { try { location.reload(); } catch (e) {} }, 2500);
              }
              return;
            }
            try { if (window.__prexStatsRefresh) window.__prexStatsRefresh(); } catch (e) {}
          });
        })
        .catch(function (e) { console.warn('trackUpload: fetch failed', e); });
    } catch (e) { /* silent */ }
  }

  /* ---------- download ---------- */
  function downloadResult() {
    if (!currentResult) return;
    const base = (currentFile.name || 'video.mp4').replace(/\.[a-z0-9]+$/i, '');
    const suffix = $('mode').value === 'prex' ? '-prex' : $('mode').value === 'patch' ? '-optimized' : $('mode').value === 'reencode' ? '-forge' : $('mode').value === 'method' ? '-prex' : '-normalized';
    const outName = base + suffix + '.mp4';
    const blob = new Blob([currentResult.bytes], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    logLine('', '> download started: ' + outName);
    toast('ok', 'Download started: ' + outName);
  }
  $('download-btn').addEventListener('click', downloadResult);

  /* ===== V5 HISTORY (IndexedDB) ===== */
  function histDB() {
    return new Promise((ok, err) => {
      const r = indexedDB.open('prexHist', 1);
      r.onupgradeneeded = e => e.target.result.createObjectStore('opt', { keyPath: 'ts' });
      r.onsuccess = e => ok(e.target.result);
      r.onerror = () => err(r.error);
    });
  }
  async function histSave(entry) {
    try { const db = await histDB(); await new Promise((ok, err) => { const tx = db.transaction('opt', 'readwrite'); tx.objectStore('opt').put(entry); tx.oncomplete = ok; tx.onerror = () => err(tx.error); }); renderHistory(); } catch(e) {}
  }
  async function histLoad() {
    try { const db = await histDB(); return await new Promise((ok, err) => { const tx = db.transaction('opt', 'readonly'); const r = tx.objectStore('opt').getAll(); r.onsuccess = () => ok((r.result || []).sort((a,b) => b.ts - a.ts).slice(0, 30)); r.onerror = () => err(r.error); }); } catch(e) { return []; }
  }
  async function histClearAll() {
    const db = await histDB();
    await new Promise((ok) => { const tx = db.transaction('opt', 'readwrite'); tx.objectStore('opt').clear(); tx.oncomplete = ok; });
    renderHistory();
  }
  async function renderHistory() {
    const el = document.getElementById('history-list');
    if (!el) return;
    const items = await histLoad();
    if (!items.length) { el.innerHTML = '<div style="color:#8f89b5;font-size:11px;text-align:center;padding:20px 0">No optimizations yet</div>'; return; }
    el.innerHTML = items.map(e => {
      const d = new Date(e.ts);
      const sc = e.status === 'pass' ? '<span style="color:#34d97b">\u2705 Everyone</span>' : e.status === 'fail' ? '<span style="color:#ff6b81">\u274c Only Me</span>' : '<span style="color:#8f89b5">\u23f3 Pending</span>';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:rgba(255,255,255,.03);border-radius:8px;border:1px solid rgba(255,255,255,.05)">'
        + '<div><div style="font-size:11px;font-weight:600;color:#e6ddff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">' + e.name + '</div>'
        + '<div style="font-size:9px;color:#8f89b5">' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString() + ' \u00b7 ' + e.mode + '</div></div>'
        + '<div>' + sc + '</div></div>';
    }).join('');
  }
  document.getElementById('history-clear')?.addEventListener('click', async () => { await histClearAll(); });
  renderHistory();

  /* ===== V5 BATCH QUEUE ===== */
  const batchFiles = [];
  let batchBusy = false;
  const batchFileInput = $('file-input');
  if (batchFileInput) {
    batchFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 1) {
        for (const f of e.target.files) { if (batchFiles.length >= 5) break; batchFiles.push({ file: f, status: 'queued' }); }
        renderBatch();
        e.target.value = '';
        toast('ok', batchFiles.length + ' files queued');
      }
    });
  }
  function renderBatch() {
    const el = document.getElementById('batch-list');
    if (!el) return;
    const card = document.getElementById('batch-queue-card');
    if (card) card.classList.toggle('hidden', batchFiles.length === 0);
    const count = document.getElementById('batch-count');
    if (count) count.textContent = '(' + batchFiles.length + '/5)';
    el.innerHTML = batchFiles.map((b, i) => {
      const icon = b.status === 'done' ? '\u2705' : b.status === 'error' ? '\u274c' : b.status === 'processing' ? '\u23f3' : '\ud83d\udccb';
      const col = b.status === 'done' ? '#34d97b' : b.status === 'error' ? '#ff6b81' : '#c4b5fd';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 8px;background:rgba(255,255,255,.03);border-radius:6px;border:1px solid rgba(255,255,255,.05)">'
        + '<span style="color:#e6ddff;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">' + icon + ' ' + b.file.name + '</span>'
        + '<span style="color:' + col + ';font-size:10px;text-transform:capitalize">' + b.status + '</span></div>';
    }).join('');
  }
  document.getElementById('batch-clear')?.addEventListener('click', () => { if (batchBusy) return; batchFiles.length = 0; renderBatch(); });

  /* ===== V5: Save history entry after optimization ===== */
  const _origTrackUpload = trackUpload;
  trackUpload = function(size, out) {
    _origTrackUpload(size, out);
    if (currentFile && out) {
      histSave({ ts: Date.now(), name: currentFile.name, mode: $('mode').value, status: 'pending', size: currentFile.size });
    }
  };

  /* ---------- ambient parallax (desktop, no reduced motion) ---------- */
  (function initParallax() {
    const rm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (!fine || rm) return;
    document.addEventListener('mousemove', (e) => {
      const nx = e.clientX / window.innerWidth - .5;
      const ny = e.clientY / window.innerHeight - .5;
      document.body.style.setProperty('--mx', String(nx));
      document.body.style.setProperty('--my', String(ny));
    }, { passive: true });
  })();

  /* ---------- footer version toggle ---------- */
  $('ver-toggle').addEventListener('click', () => toggleCard('ver-body', 'ver-toggle'));

  /* ---------- remove / clear / optimize another ---------- */
  function resetAll() {
    currentFile = null;
    currentResult = null;
    sourceInfo = null;
    hideReportCard();
    resetResultCard();
    $('info-card').classList.add('hidden');
    $('log-card').classList.add('hidden');
    $('download-btn').classList.add('hidden');
    $('done-btn').classList.add('hidden');
    $('another-btn').classList.add('hidden');
    $('result-stats').classList.add('hidden');
    $('process-btn').classList.remove('hidden');
    $('process-btn').disabled = true;
    bar.classList.remove('visible');
    setProgress(0, 'Ready');
    engineHide();
    if (fileInput) fileInput.value = '';
  }
  $('clear-btn').addEventListener('click', () => {
    if (busy) return;
    resetAll();
    clearLog();
    $('log-card').classList.remove('hidden');
    logLine('ok', '> removed - drop a new video to start over');
    toast('info', 'File removed - ready for a new video');
  });
  $('another-btn').addEventListener('click', () => {
    if (busy) return;
    activateTab('optimize');
    resetAll();
    clearLog();
    $('log-card').classList.remove('hidden');
    logLine('ok', '> ready for a new video - drop a file or choose one');
  });

  /* ---------- log ---------- */
  function clearLog() { $('log').innerHTML = ''; }
  function logLine(cls, text) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (text) d.textContent = text;
    else d.innerHTML = '<span class="prompt">&gt;</span> System ready for optimization...';
    const logEl = $('log');
    while (logEl.children.length > 100) logEl.firstChild.remove();
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function checkClientVersion() {
    fetch('/version', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('version ' + r.status))))
      .then((v) => {
        const remote = (v || '').trim();
        const local = typeof self.PREX_JS_VERSION !== 'undefined' ? String(self.PREX_JS_VERSION) : '';
        if (!remote || !local || remote === local) return;
        logLine('warn', '> client prex.js v' + local + ' vs server v' + remote + ' - hard-refresh (Ctrl+F5) to update');
      })
      .catch(() => {});
  }
  checkClientVersion();

  function fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  /* ---------- TikTok check ---------- */
  $('check-btn').addEventListener('click', doCheck);
  $('check-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') doCheck(); });

  async function doCheck() {
    const url = $('check-url').value.trim();
    const note = $('check-note');
    const out = $('check-result');
    if (!url) { note.textContent = 'Paste a TikTok video URL first.'; return; }

    const id = extractVideoId(url);
    if (!id) {
      note.textContent = "Couldn't find a video id in that URL. A TikTok video URL looks like tiktok.com/@user/video/1234567890...";
      return;
    }

    note.textContent = 'Checking video ' + id + '...';
    out.innerHTML = '';
    out.classList.add('hidden');

    try {
      const data = await fetchApi(id);
      note.textContent = '';
      renderCheck(data);
    } catch (err) {
      note.textContent = '';
      out.classList.remove('hidden');
      out.innerHTML = '<div class="err-box">Check failed: ' + err.message + '<br>' + (err.note || 'Try opening the page in a private tab, or check that the video is public. TikTok may require login cookies for some posts; if data is missing/blocked, the video may be private or the request may need a logged-in session.') + '</div>' + onlyMeFixHelp();
      return;
    }
  }

  function extractVideoId(url) {
    const m = String(url).match(/\/video\/(\d+)/);
    if (m) return m[1];
    const n = String(url).match(/^(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[\w.-]+\/(\d+)/);
    return n ? n[1] : null;
  }

  async function fetchApi(videoId) {
    const rawUrl = $('check-url').value.trim();
    let lastErr = null;

    if (onServer()) {
      try {
        const r = await fetch('/check?url=' + encodeURIComponent(rawUrl), { headers: { 'Accept': 'application/json' } });
        const j = await r.json();
        if (j && j.ok && j.item) return j.item;
        const e = new Error((j && j.error) || 'HTTP ' + r.status);
        if (j && j.note) e.note = j.note;
        throw e;
      } catch (e) {
        const wrapped = new Error('server check failed: ' + e.message);
        if (e.note) wrapped.note = e.note;
        throw wrapped;
      }
    }

    const endpoints = [
      'https://www.tiktok.com/api/item/detail/?aid=1988&app_language=en&itemId=' + videoId,
      'https://www.tiktok.com/api/item/detail/?aid=1988&app_language=en&aweme_id=' + videoId,
    ];
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j && j.itemInfo && j.itemInfo.itemStruct) return j.itemInfo.itemStruct;
        if (j && j.aweme_detail) return j.aweme_detail;
        throw new Error('unexpected response shape');
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('Direct fetch blocked (CORS). Run "node server.js" in this folder and open http://localhost:3000 to enable Check. (' + (lastErr && lastErr.message) + ')');
  }

  function renderCheck(item) {
    const out = $('check-result');
    out.classList.remove('hidden');

    const v = item.video || {};
    const w = v.width || (v.ratio && String(v.ratio).split(':')[0]);
    const h = v.height || (v.ratio && String(v.ratio).split(':')[1]);
    const durMs = v.duration || 0;
    const durSec = durMs > 6000 ? Math.round(durMs / 1000) : durMs;

    const playAddr = (v.playAddr && v.playAddr.urlList && v.playAddr.urlList[0])
      || (v.play_addr && v.play_addr.url_list && v.play_addr.url_list[0])
      || (v.download_addr && v.download_addr.url_list && v.download_addr.url_list[0])
      || null;
    const bitrate = v.bitrate || 0;
    const wNum = Number(w) || 0;
    const tier = wNum >= 2160 ? '4K' : wNum >= 1440 ? '2K' : wNum >= 1080 ? '1080p' : wNum >= 720 ? '720p' : wNum ? 'SD' : '?';
    const tierCls = wNum >= 2160 ? 't4k' : wNum >= 1440 ? 't2k' : wNum >= 1080 ? 't1080' : wNum >= 720 ? 't720' : 'tsd';
    const geo = '<span class="check-badge ' + tierCls + '">' + tier + '</span>';

    const cells = [
      ['Author', (item.author && item.author.uniqueId) || '?'],
      ['Title', (item.desc || '').slice(0, 60) || '?'],
      ['Served at', w && h ? w + 'x' + h + ' ' + geo : '?'],
      ['Visibility', '<span class="v-good">Public — TikTok is serving it</span>'],
      ['Duration', durSec ? durSec + ' s' : '?'],
      ['Video bitrate', bitrate ? '<span class="v-good">' + (bitrate / 1e6).toFixed(1) + ' Mbps</span>' : '?'],
      ['Remote play', playAddr ? '<span class="v-good">available</span>' : '<span class="v-bad">restricted</span>'],
    ].map(([k, val]) => '<div class="info-cell"><div class="k">' + k + '</div><div class="v">' + val + '</div></div>').join('');

    out.innerHTML =
      '<div class="card-head">Served video info</div>' +
      '<div class="check-grid up">' + cells + '</div>' +
      (playAddr
        ? '<div class="hint" style="margin-top:10px">play_addr detected — you can open the served stream URL in a new tab to inspect exact fps/size.</div>'
        : '<div class="hint" style="margin-top:10px">play_addr not exposed without a logged-in session; resolution/bitrate above may be partial.</div>');
  }

  /* ---------- only-me report (privacy feedback) ---------- */
  function onlyMeFixHelp() {
    return '<div class="card" style="margin-top:10px"><div class="card-head">Only me? Fix it in 10 seconds</div><div class="card-body" style="padding:12px 16px"><ol style="margin:0;padding-left:18px;line-height:1.7">' +
      '<li>Open the posted video on tiktok.com (or the app).</li>' +
      '<li>Tap the <b>three dots</b> on the video &rarr; <b>Privacy</b> (or Settings &rarr; Privacy).</li>' +
      '<li>Switch visibility back to <b>Everyone</b> and save.</li>' +
      '<li>Re-run this check &mdash; it should now show <b>Public</b>.</li>' +
      '</ol><div class="hint" style="margin-top:8px">If it keeps reverting to "Only me": clear tiktok.com cookies, re-login, and post again with "Everyone" re-selected right before clicking Post (TikTok Studio web bug).</div></div></div>';
  }
  function showReportCard(out) {
    const rc = $('report-card');
    if (!rc) return;
    const actions = $('report-actions');
    const fix = $('report-fix');
    if (actions) actions.style.display = '';
    if (fix) { fix.classList.add('hidden'); fix.innerHTML = ''; }
    rc.classList.remove('hidden');
  }
  function hideReportCard() {
    const rc = $('report-card');
    if (rc) rc.classList.add('hidden');
  }
  function sendReport(ok) {
    let meta = { mode: '', w: 0, h: 0 };
    if (currentResult) {
      try {
        const info = P.analyze(currentResult.bytes, new DataView(currentResult.buffer, currentResult.byteOffset || 0, currentResult.buffer.byteLength));
        meta.w = info.width || 0;
        meta.h = info.height || 0;
      } catch (e) { /* optional */ }
      meta.mode = $('mode').value;
    }
    fetch('api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'ok=' + (ok ? '1' : '0') + '&mode=' + encodeURIComponent(meta.mode || '') + '&w=' + (meta.w || 0) + '&h=' + (meta.h || 0),
      credentials: 'same-origin',
      keepalive: true,
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (j && j.ok) {
            const actions = $('report-actions');
            const fix = $('report-fix');
            if (actions) actions.style.display = 'none';
            if (ok && fix) {
              fix.innerHTML = onlyMeFixHelp();
              fix.classList.remove('hidden');
            }
            toast('ok', ok ? 'Logged — use the steps above to flip it back to Everyone.' : 'Thanks! Logged as public.');
          } else {
            toast('err', (j && j.error) || 'Report failed to save.');
          }
        });
      })
      .catch(function () { toast('err', 'Report failed to save.'); });
  }
  const reportNoBtn = $('report-no');
  if (reportNoBtn) reportNoBtn.addEventListener('click', function () { sendReport(false); });
  const reportYesBtn = $('report-yes');
  if (reportYesBtn) reportYesBtn.addEventListener('click', function () { sendReport(true); });

  /* ---------- maintenance mode (banner + disable studio) ---------- */
  let maintOn = false;
  function maintApply(m) {
    const on = !!(m && m.on);
    const msg = (m && m.msg) || 'The studio is under maintenance / being patched right now. We\u2019ll be back shortly.';
    maintOn = on;
    const bs = $('maint-banner-studio');
    if (bs) { bs.classList.toggle('maint-on', on); const ms = $('maint-msg-studio'); if (ms) ms.textContent = msg; }
    const bl = $('maint-banner-landing');
    if (bl) { bl.classList.toggle('maint-on', on); const ml = $('maint-msg-landing'); if (ml) ml.textContent = msg; }
    const pb = $('process-btn');
    if (pb) pb.disabled = on || !currentFile;
    const fi = $('file-input');
    if (fi) fi.disabled = on;
  }
  async function maintPoll() {
    try {
      const r = await fetch('api/status', { cache: 'no-store', credentials: 'same-origin' });
      const j = await r.json();
      maintApply(j.maintenance);
    } catch (e) { /* keep last known state */ }
  }
  maintPoll();
  setInterval(maintPoll, 20000);

  /* ---------- additive API exposure (v5.1 features.js) ---------- */
  window.__PREX_API = {
    onFile: onFile,
    process: process,
    trackUpload: trackUpload,
    getBusy: function () { return busy; },
    hasFile: function () { return !!currentFile; },
    getFile: function () { return currentFile; },
    getSourceInfo: function () { return sourceInfo; },
  };
})();