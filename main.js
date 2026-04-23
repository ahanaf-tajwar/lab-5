/* =========================================================================
   Pitch Set Composer — main.js
   COMS 3430 · Lab 5 · Automated Composition

   Contents:
     §1  Pitch set operations (transpose / retrograde / invert)
     §2  Composition generator
     §3  Synth engine (additive / AM / FM with ADSR)
     §4  Scheduler (plays a generated sequence)
     §5  Input parsing + state
     §6  Visualizations (pitch-class circle, piano roll, 12-tone matrix)
     §7  UI wiring
   ========================================================================= */


/* =========================================================================
   §1  Pitch set operations
   --------------------------------------------------------------------------
   A pitch class is an integer 0..11 (mod 12).
   A pitch class set, for this lab, is an ordered array of pitch classes
   (following the instructor's examples in Lec 22, where operations preserve
   order — e.g. retrograde reverses, transpose shifts pointwise).
   ========================================================================= */

const MOD = 12;

const mod12 = n => ((n % MOD) + MOD) % MOD;

// transpose(set, n): shift every pitch up by n semitones, mod 12.
// {0,2,4,5} + 2 → {2,4,6,7}
const transpose = (set, n) => set.map(p => mod12(p + n));

// retrograde(set): reverse the sequence.
// [0,2,4,5] → [5,4,2,0]
const retrograde = set => [...set].reverse();

// invert(set, axis): reflect each pitch around `axis` (defaults to set[0]).
// The lecture example {0,2,4,5} → {0,10,8,7} is inversion around 0,
// using the formula: I_a(p) = (2a - p) mod 12.
const invert = (set, axis) => {
  const a = axis === undefined ? set[0] : axis;
  return set.map(p => mod12(2 * a - p));
};

// Composite operation helpers, useful for the 12-tone matrix.
// T_n(P):     transpose(set, n)
// I_n(P):     transpose(invert(set), n - set[0])     → invert then re-anchor
// R(P):       retrograde(set)
// RI_n(P):    retrograde(I_n(P))
//
// Convention: I label the inversion relative to the starting pitch so that
// I0 keeps set[0] fixed (matching the lecture's {0,2,4,5} → {0,10,8,7}).
const T = (set, n) => transpose(set, n);
const I = (set, n = 0) => {
  // invert around set[0] (keeps first note fixed), then transpose by n.
  const inverted = invert(set, set[0]);
  return transpose(inverted, n);
};
const R = set => retrograde(set);
const RI = (set, n = 0) => retrograde(I(set, n));


/* =========================================================================
   §2  Composition generator
   --------------------------------------------------------------------------
   Given an initial set, produce a list of "segments", each of which is
   a transformed copy of the row plus a human-readable label describing
   which operation produced it.
   ========================================================================= */

// Weighted random choice from an object {key: weight}
const weightedPick = weights => {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total === 0) return entries[0]?.[0];
  let r = Math.random() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
};

// Apply a randomly-chosen operation to `current`. Returns {set, label}.
const applyRandomOp = (current, weights) => {
  const op = weightedPick(weights);
  const n = Math.floor(Math.random() * 12);
  switch (op) {
    case 'T':  return { set: T(current, n),     label: `T${n}`  };
    case 'I':  return { set: I(current, n),     label: `T${n}I` };
    case 'R':  return { set: R(current),        label: `R`     };
    case 'P':  return { set: [...current],      label: `P`     };
    default:   return { set: [...current],      label: `P`     };
  }
};

// Build a composition: an array of {set, label} segments.
const generateComposition = (seed, numSegments, weights) => {
  const segments = [{ set: [...seed], label: 'P' }];
  let current = seed;
  for (let i = 1; i < numSegments; i++) {
    const next = applyRandomOp(current, weights);
    segments.push(next);
    current = next.set;
  }
  return segments;
};


/* =========================================================================
   §3  Synth engine
   --------------------------------------------------------------------------
   Ported from Lab 2. Three modes:
     - additive: sum of fundamental + 3 partials at decreasing amplitudes
     - AM:       carrier modulated by modulator (gain-based)
     - FM:       carrier's frequency modulated by modulator
   All voices share a master gain node that goes to audioContext.destination.
   Each note gets its own ADSR-shaped gain node so voices don't click.
   ========================================================================= */

// MIDI-like pitch → frequency. We use pitch class + octave to get a MIDI note.
const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
const pcToMidi = (pc, octave) => pc + 12 * (octave + 1); // MIDI: C0 = 12, so C4 = 60

let audioContext = null;
let masterGain = null;

const initAudio = () => {
  if (audioContext) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioContext.createGain();
  masterGain.gain.value = parseFloat(document.getElementById('master').value);
  masterGain.connect(audioContext.destination);
};

// Play a single note starting at absolute audioContext time `startTime`,
// for `duration` seconds. Returns a Promise that resolves when the voice
// is fully released, so callers can clean up.
const playNote = (freq, startTime, duration, params) => {
  const { mode, attack, decay, sustain, release,
          modFreq, modDepth } = params;

  // Per-voice gain with ADSR applied.
  const voiceGain = audioContext.createGain();
  voiceGain.connect(masterGain);

  // ADSR envelope shape, anchored to startTime.
  // Attack: 0 → 1 over `attack` s
  // Decay:  1 → sustain over `decay` s
  // Sustain: held through the body of the note
  // Release: sustain → 0 over `release` s after noteOff
  const noteOff = startTime + duration;
  const endTime = noteOff + release;
  const g = voiceGain.gain;
  g.setValueAtTime(0, startTime);
  g.linearRampToValueAtTime(1.0, startTime + attack);
  g.linearRampToValueAtTime(sustain, startTime + attack + decay);
  g.setValueAtTime(sustain, noteOff);
  g.linearRampToValueAtTime(0, endTime);

  const sources = [];

  if (mode === 'additive') {
    // Fundamental + 3 harmonic partials with decreasing amplitude.
    // Each partial is its own oscillator → its own gain → voiceGain.
    const partials = [
      { ratio: 1, amp: 0.7 },
      { ratio: 2, amp: 0.25 },
      { ratio: 3, amp: 0.15 },
      { ratio: 4, amp: 0.08 },
    ];
    partials.forEach(({ ratio, amp }) => {
      const osc = audioContext.createOscillator();
      const partialGain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * ratio;
      partialGain.gain.value = amp;
      osc.connect(partialGain);
      partialGain.connect(voiceGain);
      osc.start(startTime);
      osc.stop(endTime + 0.02);
      sources.push(osc);
    });

  } else if (mode === 'am') {
    // AM: modulator's output multiplies carrier's amplitude.
    // Pattern (from lecture): mod → modGain → carrierGain.gain
    //                         carrier → carrierGain → voiceGain
    const carrier = audioContext.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = freq;

    const carrierGain = audioContext.createGain();
    carrierGain.gain.value = 0.5; // DC offset so mod is bipolar around this

    const mod = audioContext.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = modFreq;

    const modGain = audioContext.createGain();
    modGain.gain.value = 0.5; // modulation index

    mod.connect(modGain);
    modGain.connect(carrierGain.gain);
    carrier.connect(carrierGain);
    carrierGain.connect(voiceGain);

    carrier.start(startTime);
    mod.start(startTime);
    carrier.stop(endTime + 0.02);
    mod.stop(endTime + 0.02);
    sources.push(carrier, mod);

  } else if (mode === 'fm') {
    // FM: modulator's output is added to carrier's frequency.
    // Pattern (from lecture): mod → modGain → carrier.frequency
    //                         carrier → voiceGain
    const carrier = audioContext.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = freq;

    const mod = audioContext.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = modFreq;

    const modGain = audioContext.createGain();
    modGain.gain.value = modDepth; // in Hz

    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(voiceGain);

    carrier.start(startTime);
    mod.start(startTime);
    carrier.stop(endTime + 0.02);
    mod.stop(endTime + 0.02);
    sources.push(carrier, mod);
  }

  return { endTime, sources };
};


/* =========================================================================
   §4  Scheduler
   --------------------------------------------------------------------------
   Walk through the segments, play each pitch as a sequential note.
   Uses audioContext.currentTime to schedule everything ahead so timing is
   rock-solid (not dependent on JS timer jitter).
   Also emits visual callbacks so the piano roll + circle can follow along.
   ========================================================================= */

let activeVoices = [];   // {sources, endTime} for cleanup / stop
let scheduledRAFs = [];  // requestAnimationFrame IDs for UI updates
let playheadRAF = null;

const stopPlayback = () => {
  const now = audioContext ? audioContext.currentTime : 0;
  for (const v of activeVoices) {
    for (const s of v.sources) {
      try { s.stop(now); } catch (_) { /* already stopped */ }
    }
  }
  activeVoices = [];
  scheduledRAFs.forEach(id => clearTimeout(id));
  scheduledRAFs = [];
  if (playheadRAF) { cancelAnimationFrame(playheadRAF); playheadRAF = null; }
  document.getElementById('play-btn').disabled = false;
  document.getElementById('stop-btn').disabled = true;
  setStatus('stopped');
  clearPlayhead();
  clearNowPlaying();
};

const playComposition = (segments, params) => {
  initAudio();
  if (audioContext.state === 'suspended') audioContext.resume();

  const { tempo, noteLength, octave } = params;
  const secondsPerNote = 60 / tempo;
  const startTime = audioContext.currentTime + 0.1;

  let cursor = startTime;
  const timeline = []; // {time, pc, segIdx, noteIdx}

  segments.forEach((seg, segIdx) => {
    seg.set.forEach((pc, noteIdx) => {
      const freq = midiToFreq(pcToMidi(pc, octave));
      const voice = playNote(freq, cursor, noteLength, params);
      activeVoices.push(voice);
      timeline.push({ time: cursor - startTime, pc, segIdx, noteIdx });
      cursor += secondsPerNote;
    });
  });

  const totalDuration = cursor - startTime;

  // Schedule UI callbacks (highlight which note is playing).
  timeline.forEach(evt => {
    const delayMs = evt.time * 1000;
    const id = setTimeout(() => {
      highlightNow(evt.segIdx, evt.noteIdx, evt.pc);
    }, delayMs);
    scheduledRAFs.push(id);
  });

  // Stop button enabled, playhead animation running.
  document.getElementById('play-btn').disabled = true;
  document.getElementById('stop-btn').disabled = false;
  setStatus('playing');
  animatePlayhead(startTime, totalDuration);

  // Auto-cleanup when finished.
  const endId = setTimeout(() => {
    stopPlayback();
  }, (totalDuration + 0.5) * 1000);
  scheduledRAFs.push(endId);
};

// Play one arbitrary row once (used by matrix-cell clicks).
const playRowOnce = (set, params) => {
  initAudio();
  if (audioContext.state === 'suspended') audioContext.resume();

  const { tempo, noteLength, octave } = params;
  const secondsPerNote = 60 / tempo;
  const startTime = audioContext.currentTime + 0.05;

  set.forEach((pc, i) => {
    const freq = midiToFreq(pcToMidi(pc, octave));
    const voice = playNote(freq, startTime + i * secondsPerNote, noteLength, params);
    activeVoices.push(voice);
  });
};


/* =========================================================================
   §5  Input parsing + state
   ========================================================================= */

const NOTE_TO_PC = {
  'C': 0, 'C#': 1, 'DB': 1, 'D': 2, 'D#': 3, 'EB': 3,
  'E': 4, 'F': 5, 'F#': 6, 'GB': 6, 'G': 7, 'G#': 8,
  'AB': 8, 'A': 9, 'A#': 10, 'BB': 10, 'B': 11
};
const PC_TO_NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

// Accept "0,2,4,5" or "C, D, E, F" or "0 2 4 5" or mixed.
const parseRow = input => {
  const tokens = input
    .toUpperCase()
    .replace(/[{}\[\]()]/g, '')
    .split(/[\s,;]+/)
    .filter(Boolean);

  const set = [];
  for (const tok of tokens) {
    if (/^-?\d+$/.test(tok)) {
      set.push(mod12(parseInt(tok, 10)));
    } else if (NOTE_TO_PC.hasOwnProperty(tok)) {
      set.push(NOTE_TO_PC[tok]);
    } else {
      return null; // invalid token
    }
  }
  return set.length >= 2 && set.length <= 12 ? set : null;
};

// Global app state. Kept explicit (no framework, just a bag).
const state = {
  row: [0, 1, 5, 6, 7, 11],
  segments: [],
};


/* =========================================================================
   §6  Visualizations
   ========================================================================= */

// ---- 6a. Pitch-class circle ------------------------------------------------

const drawCircle = (set) => {
  const svg = document.getElementById('pitch-circle');
  svg.innerHTML = '';
  const cx = 200, cy = 200, r = 150;
  const svgNS = 'http://www.w3.org/2000/svg';

  // Outer ring
  const ring = document.createElementNS(svgNS, 'circle');
  ring.setAttribute('cx', cx); ring.setAttribute('cy', cy); ring.setAttribute('r', r);
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'rgba(244,234,211,0.1)');
  ring.setAttribute('stroke-width', '1');
  svg.appendChild(ring);

  // Edges connecting set members (in order)
  if (set.length > 1) {
    const pts = set.map(pc => pcToXY(pc, cx, cy, r));
    for (let i = 0; i < pts.length - 1; i++) {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', pts[i].x); line.setAttribute('y1', pts[i].y);
      line.setAttribute('x2', pts[i + 1].x); line.setAttribute('y2', pts[i + 1].y);
      line.setAttribute('class', 'pc-edge');
      svg.appendChild(line);
    }
  }

  // 12 pitch-class dots + labels
  const setHash = new Set(set);
  for (let pc = 0; pc < 12; pc++) {
    const { x, y } = pcToXY(pc, cx, cy, r);
    const active = setHash.has(pc);

    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    dot.setAttribute('r', active ? 10 : 5);
    dot.setAttribute('fill', active ? 'var(--amber)' : 'rgba(244,234,211,0.2)');
    dot.setAttribute('class', 'pc-dot');
    dot.setAttribute('data-pc', pc);
    svg.appendChild(dot);

    const label = document.createElementNS(svgNS, 'text');
    const lx = cx + (r + 22) * Math.sin((pc / 12) * 2 * Math.PI);
    const ly = cy - (r + 22) * Math.cos((pc / 12) * 2 * Math.PI);
    label.setAttribute('x', lx); label.setAttribute('y', ly);
    label.setAttribute('class', active ? 'pc-label active' : 'pc-label');
    label.textContent = PC_TO_NOTE[pc];
    svg.appendChild(label);
  }

  // Current-note highlight ring (moved around during playback)
  const nowRing = document.createElementNS(svgNS, 'circle');
  nowRing.setAttribute('id', 'pc-now-ring');
  nowRing.setAttribute('r', 16);
  nowRing.setAttribute('fill', 'none');
  nowRing.setAttribute('stroke', '#fff');
  nowRing.setAttribute('stroke-width', '2');
  nowRing.setAttribute('class', 'pc-now');
  nowRing.setAttribute('opacity', '0');
  svg.appendChild(nowRing);
};

const pcToXY = (pc, cx, cy, r) => ({
  x: cx + r * Math.sin((pc / 12) * 2 * Math.PI),
  y: cy - r * Math.cos((pc / 12) * 2 * Math.PI),
});

const highlightCirclePc = pc => {
  const svg = document.getElementById('pitch-circle');
  const nowRing = svg.querySelector('#pc-now-ring');
  if (!nowRing) return;
  const { x, y } = pcToXY(pc, 200, 200, 150);
  nowRing.setAttribute('cx', x);
  nowRing.setAttribute('cy', y);
  nowRing.setAttribute('opacity', '1');
};

// ---- 6b. Piano roll --------------------------------------------------------

const drawPianoRoll = segments => {
  const svg = document.getElementById('piano-roll');
  const W = 800, H = 300;
  const margin = { top: 16, right: 12, bottom: 24, left: 32 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';
  const svgNS = 'http://www.w3.org/2000/svg';

  // total notes across all segments
  const totalNotes = segments.reduce((s, seg) => s + seg.set.length, 0);
  if (totalNotes === 0) return;
  const noteW = plotW / totalNotes;
  const rowH = plotH / 12;

  // Background
  const bg = document.createElementNS(svgNS, 'rect');
  bg.setAttribute('x', margin.left); bg.setAttribute('y', margin.top);
  bg.setAttribute('width', plotW); bg.setAttribute('height', plotH);
  bg.setAttribute('class', 'roll-bg');
  svg.appendChild(bg);

  // Horizontal gridlines (one per pitch class) + y-axis labels
  for (let pc = 0; pc <= 12; pc++) {
    const y = margin.top + pc * rowH;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', margin.left); line.setAttribute('x2', margin.left + plotW);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('class', pc % 12 === 0 ? 'roll-gridline-strong' : 'roll-gridline');
    svg.appendChild(line);

    if (pc < 12) {
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', margin.left - 6);
      label.setAttribute('y', margin.top + (11 - pc) * rowH + rowH / 2 + 3);
      label.setAttribute('class', 'roll-seg-label');
      label.setAttribute('text-anchor', 'end');
      label.textContent = PC_TO_NOTE[pc];
      svg.appendChild(label);
    }
  }

  // Draw notes + segment dividers
  let noteIdx = 0;
  segments.forEach((seg, segIdx) => {
    const segStart = noteIdx;
    seg.set.forEach(pc => {
      const x = margin.left + noteIdx * noteW;
      const y = margin.top + (11 - pc) * rowH;
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', Math.max(noteW - 1, 1));
      rect.setAttribute('height', rowH);
      rect.setAttribute('class', 'roll-note');
      rect.setAttribute('data-seg', segIdx);
      rect.setAttribute('data-note', noteIdx - segStart);
      rect.setAttribute('id', `roll-note-${segIdx}-${noteIdx - segStart}`);
      svg.appendChild(rect);
      noteIdx++;
    });

    // Divider after each segment
    if (segIdx < segments.length - 1) {
      const x = margin.left + noteIdx * noteW;
      const div = document.createElementNS(svgNS, 'line');
      div.setAttribute('x1', x); div.setAttribute('x2', x);
      div.setAttribute('y1', margin.top); div.setAttribute('y2', margin.top + plotH);
      div.setAttribute('class', 'roll-seg-divider');
      svg.appendChild(div);
    }

    // Label above each segment
    const labelX = margin.left + (segStart + seg.set.length / 2) * noteW;
    const lbl = document.createElementNS(svgNS, 'text');
    lbl.setAttribute('x', labelX);
    lbl.setAttribute('y', margin.top - 4);
    lbl.setAttribute('class', 'roll-seg-label');
    lbl.setAttribute('text-anchor', 'middle');
    lbl.textContent = seg.label;
    svg.appendChild(lbl);
  });

  // Playhead line (hidden until playback)
  const playhead = document.createElementNS(svgNS, 'line');
  playhead.setAttribute('id', 'playhead');
  playhead.setAttribute('x1', margin.left); playhead.setAttribute('x2', margin.left);
  playhead.setAttribute('y1', margin.top); playhead.setAttribute('y2', margin.top + plotH);
  playhead.setAttribute('class', 'roll-playhead');
  playhead.setAttribute('opacity', '0');
  svg.appendChild(playhead);
};

const animatePlayhead = (startTime, duration) => {
  const svg = document.getElementById('piano-roll');
  const playhead = svg.querySelector('#playhead');
  if (!playhead) return;
  const margin = { left: 32, right: 12 };
  const W = 800;
  const plotW = W - margin.left - margin.right;
  playhead.setAttribute('opacity', '1');

  const tick = () => {
    if (!audioContext) return;
    const t = audioContext.currentTime - startTime;
    if (t < 0) { playheadRAF = requestAnimationFrame(tick); return; }
    if (t > duration) { clearPlayhead(); return; }
    const x = margin.left + (t / duration) * plotW;
    playhead.setAttribute('x1', x);
    playhead.setAttribute('x2', x);
    playheadRAF = requestAnimationFrame(tick);
  };
  tick();
};

const clearPlayhead = () => {
  const playhead = document.querySelector('#playhead');
  if (playhead) playhead.setAttribute('opacity', '0');
};

const highlightNow = (segIdx, noteIdx, pc) => {
  clearNowPlaying();
  const note = document.getElementById(`roll-note-${segIdx}-${noteIdx}`);
  if (note) note.classList.add('roll-note-playing');
  highlightCirclePc(pc);
};

const clearNowPlaying = () => {
  document.querySelectorAll('.roll-note-playing').forEach(n => n.classList.remove('roll-note-playing'));
  const ring = document.getElementById('pc-now-ring');
  if (ring) ring.setAttribute('opacity', '0');
};

// ---- 6c. 12-tone matrix ----------------------------------------------------

// For a given row P, the classic 12-tone matrix is:
//   row i  = T_i(P - P[0])    (i.e. transposition starting on P[0] + i)
//   col j  = I_j equivalents
// More precisely: cell[i][j] = (P[j] - P[0] + row_offset) mod 12, where
// row_offset is chosen so the diagonal shows P.
// A common convention: M[i][j] = mod12( P[j] + (P[0] - I_row[0]) ... )
// — I implement it directly: each row is T_k(P) for some k, and each column
// is an inversion of the first column.
const buildMatrix = row => {
  const n = row.length;
  // I_row is inversion of the row around row[0]: keeps row[0], flips rest.
  const Irow = invert(row, row[0]);
  const matrix = [];
  for (let i = 0; i < n; i++) {
    // row i is the row transposed so it starts at Irow[i]
    const shift = mod12(Irow[i] - row[0]);
    matrix.push(transpose(row, shift));
  }
  return matrix;
};

const drawMatrix = row => {
  const wrap = document.getElementById('matrix-wrap');
  wrap.innerHTML = '';
  const n = row.length;
  if (n < 2) return;
  const matrix = buildMatrix(row);

  // Top-left corner empty
  const corner = document.createElement('div');
  wrap.appendChild(corner);

  // Top labels (I0..In-1)
  const topLabels = document.createElement('div');
  topLabels.className = 'matrix-grid';
  topLabels.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  for (let j = 0; j < n; j++) {
    const l = document.createElement('div');
    l.className = 'matrix-label';
    l.textContent = `I${matrix[0][j]}`;
    topLabels.appendChild(l);
  }
  wrap.appendChild(topLabels);

  // Top-right corner empty
  const corner2 = document.createElement('div');
  wrap.appendChild(corner2);

  // Left labels (P rows)
  const leftLabels = document.createElement('div');
  leftLabels.className = 'matrix-grid';
  leftLabels.style.gridTemplateRows = `repeat(${n}, 1fr)`;
  for (let i = 0; i < n; i++) {
    const l = document.createElement('div');
    l.className = 'matrix-label';
    l.textContent = `P${matrix[i][0]}`;
    leftLabels.appendChild(l);
  }
  wrap.appendChild(leftLabels);

  // The matrix itself
  const grid = document.createElement('div');
  grid.className = 'matrix-grid';
  grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${n}, 1fr)`;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const cell = document.createElement('button');
      cell.className = 'matrix-cell' + (i === j ? ' diag' : '');
      cell.textContent = matrix[i][j];
      cell.dataset.row = i;
      cell.dataset.col = j;
      cell.title = `Row P${matrix[i][0]} · Col I${matrix[0][j]} → click: play P${matrix[i][0]}`;
      cell.addEventListener('click', () => {
        // Clicking any row plays that transposition of P forwards.
        playRowOnce(matrix[i], readSynthParams());
        cell.classList.add('playing');
        setTimeout(() => cell.classList.remove('playing'), 600);
      });
      grid.appendChild(cell);
    }
  }
  wrap.appendChild(grid);

  // Right labels (R rows)
  const rightLabels = document.createElement('div');
  rightLabels.className = 'matrix-grid';
  rightLabels.style.gridTemplateRows = `repeat(${n}, 1fr)`;
  for (let i = 0; i < n; i++) {
    const l = document.createElement('div');
    l.className = 'matrix-label';
    l.textContent = `R${matrix[i][0]}`;
    rightLabels.appendChild(l);
  }
  wrap.appendChild(rightLabels);

  // Bottom corner empty
  const c3 = document.createElement('div'); wrap.appendChild(c3);

  // Bottom labels (RI cols)
  const bottomLabels = document.createElement('div');
  bottomLabels.className = 'matrix-grid';
  bottomLabels.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  for (let j = 0; j < n; j++) {
    const l = document.createElement('div');
    l.className = 'matrix-label';
    l.textContent = `RI${matrix[0][j]}`;
    bottomLabels.appendChild(l);
  }
  wrap.appendChild(bottomLabels);

  const c4 = document.createElement('div'); wrap.appendChild(c4);
};


/* =========================================================================
   §7  UI wiring
   ========================================================================= */

// Helpers to read current params
const readSynthParams = () => {
  const activeTab = document.querySelector('.mode-tab.active');
  return {
    mode: activeTab ? activeTab.dataset.mode : 'additive',
    attack: parseFloat(document.getElementById('attack').value),
    decay: parseFloat(document.getElementById('decay').value),
    sustain: parseFloat(document.getElementById('sustain').value),
    release: parseFloat(document.getElementById('release').value),
    modFreq: parseFloat(document.getElementById('modfreq').value),
    modDepth: parseFloat(document.getElementById('moddepth').value),
    tempo: parseFloat(document.getElementById('tempo').value),
    noteLength: parseFloat(document.getElementById('notelen').value),
    octave: parseInt(document.getElementById('octave').value, 10),
  };
};

const readOperationWeights = () => ({
  T: parseFloat(document.getElementById('wT').value),
  I: parseFloat(document.getElementById('wI').value),
  R: parseFloat(document.getElementById('wR').value),
  P: parseFloat(document.getElementById('wP').value),
});

const setStatus = s => {
  document.getElementById('status').textContent = s;
};

// Refresh everything visual that depends on `state.row`
const refreshRowVisuals = () => {
  // Parsed row display
  const parsed = document.getElementById('parsed-row');
  parsed.innerHTML = state.row.map(pc =>
    `<span class="pc">${pc} · ${PC_TO_NOTE[pc]}</span>`
  ).join('');
  drawCircle(state.row);
  drawMatrix(state.row);
};

const refreshCompositionVisuals = () => {
  drawPianoRoll(state.segments);

  // Operation legend (unique labels found in segments)
  const legend = document.getElementById('op-legend');
  const seen = new Set();
  state.segments.forEach(s => seen.add(s.label));
  legend.innerHTML = [...seen].map(label => {
    return `<div class="op-legend-item"><div class="op-legend-swatch" style="background:var(--amber)"></div>${label}</div>`;
  }).join('');
};

// Random 12-tone row (permutation of 0..11)
const randomRow = () => {
  const row = [0,1,2,3,4,5,6,7,8,9,10,11];
  for (let i = row.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [row[i], row[j]] = [row[j], row[i]];
  }
  return row;
};

// ----- Event bindings -----

document.addEventListener('DOMContentLoaded', () => {
  // Init from default input
  state.row = parseRow(document.getElementById('row-input').value) || state.row;
  refreshRowVisuals();

  // Sliders: live label updates
  const sliderBindings = [
    ['segments', 'val-segments', v => v],
    ['tempo', 'val-tempo', v => v],
    ['notelen', 'val-notelen', v => `${parseFloat(v).toFixed(2)}s`],
    ['octave', 'val-octave', v => v],
    ['wT', 'val-wT', v => parseFloat(v).toFixed(2)],
    ['wI', 'val-wI', v => parseFloat(v).toFixed(2)],
    ['wR', 'val-wR', v => parseFloat(v).toFixed(2)],
    ['wP', 'val-wP', v => parseFloat(v).toFixed(2)],
    ['attack', 'val-attack', v => `${parseFloat(v).toFixed(3)}s`],
    ['decay', 'val-decay', v => `${parseFloat(v).toFixed(3)}s`],
    ['sustain', 'val-sustain', v => parseFloat(v).toFixed(2)],
    ['release', 'val-release', v => `${parseFloat(v).toFixed(3)}s`],
    ['modfreq', 'val-modfreq', v => `${parseFloat(v).toFixed(1)}Hz`],
    ['moddepth', 'val-moddepth', v => parseFloat(v).toFixed(0)],
    ['master', 'val-master', v => parseFloat(v).toFixed(2)],
  ];
  sliderBindings.forEach(([id, labelId, fmt]) => {
    const el = document.getElementById(id);
    const lbl = document.getElementById(labelId);
    if (!el || !lbl) return;
    const update = () => { lbl.textContent = fmt(el.value); };
    update();
    el.addEventListener('input', update);
  });

  // Master gain reflects slider live (if audio is running)
  document.getElementById('master').addEventListener('input', e => {
    if (masterGain) masterGain.gain.value = parseFloat(e.target.value);
  });

  // Row input → re-parse on change
  document.getElementById('row-input').addEventListener('input', e => {
    const parsed = parseRow(e.target.value);
    if (parsed) {
      state.row = parsed;
      refreshRowVisuals();
      setStatus('row updated');
    } else {
      setStatus('invalid row');
    }
  });

  // Preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      let row;
      if (preset === 'random') {
        row = randomRow();
      } else {
        row = parseRow(preset);
      }
      if (row) {
        state.row = row;
        document.getElementById('row-input').value = row.join(', ');
        refreshRowVisuals();
        setStatus('preset loaded');
      }
    });
  });

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });

  // Generate
  document.getElementById('generate-btn').addEventListener('click', () => {
    const segN = parseInt(document.getElementById('segments').value, 10);
    state.segments = generateComposition(state.row, segN, readOperationWeights());
    refreshCompositionVisuals();
    document.getElementById('play-btn').disabled = false;
    setStatus(`generated ${segN} segments`);
  });

  // Play
  document.getElementById('play-btn').addEventListener('click', () => {
    if (state.segments.length === 0) {
      const segN = parseInt(document.getElementById('segments').value, 10);
      state.segments = generateComposition(state.row, segN, readOperationWeights());
      refreshCompositionVisuals();
    }
    playComposition(state.segments, readSynthParams());
  });

  // Stop
  document.getElementById('stop-btn').addEventListener('click', stopPlayback);

  // Generate an initial composition so Play works immediately
  state.segments = generateComposition(state.row, 8, readOperationWeights());
  refreshCompositionVisuals();
  document.getElementById('play-btn').disabled = false;
});
