/* SoundKit: twelve sounds made from code, so a page needs no downloads and no licences.
 * Shared by the prism-fx rack and Recycle Reborn (which keeps an inline copy).
 *
 *   SoundKit.list                       -> [{ id, name, group, kind, bpm, note }]
 *   SoundKit.render(id, sampleRate)     -> { left, right, sampleRate, name }   (Float32Arrays)
 *   SoundKit.toBuffer(ctx, id)          -> AudioBuffer, cached per context rate
 *
 * Every sound is seeded, so it is the same on every load. Peaks are set to -1 dBFS.
 */
(function (root) {
  'use strict';
  const TAU = Math.PI * 2;
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  }

  // RBJ biquad. set() may be called while running, for sweeps.
  function biquad(type, f, q, sr) {
    let b0, b1, b2, a1, a2, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const set = (freq, Q) => {
      const w = TAU * Math.min(freq, sr * 0.45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q);
      let n0, n1, n2;
      if (type === 'lp') { n0 = (1 - c) / 2; n1 = 1 - c; n2 = n0; }
      else if (type === 'hp') { n0 = (1 + c) / 2; n1 = -(1 + c); n2 = n0; }
      else { n0 = al; n1 = 0; n2 = -al; }
      const d0 = 1 + al;
      b0 = n0 / d0; b1 = n1 / d0; b2 = n2 / d0; a1 = -2 * c / d0; a2 = (1 - al) / d0;
    };
    set(f, q);
    return {
      set,
      run(x) { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; },
    };
  }

  function track(sr, seconds) {
    const n = Math.round(sr * seconds);
    const L = new Float32Array(n), R = new Float32Array(n);
    return {
      sr, n, L, R,
      // Mix a mono voice in at time t, with gain and equal-power pan (-1..1).
      add(t, voice, gain = 1, pan = 0) {
        const a = Math.round(t * sr), gl = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2 * gain, gr = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2 * gain;
        for (let i = 0; i < voice.length && a + i < n; i++) { if (a + i < 0) continue; L[a + i] += voice[i] * gl; R[a + i] += voice[i] * gr; }
      },
    };
  }

  // For a loop that rings past its last bar: fold the overhang onto the start,
  // so the loop is exactly `seconds` long and the ring carries over the seam.
  function wrap(t, seconds) {
    const m = Math.round(t.sr * seconds);
    if (m >= t.n) return t;
    for (let i = m; i < t.n; i++) { t.L[i - m] += t.L[i]; t.R[i - m] += t.R[i]; }
    return { ...t, n: m, L: t.L.subarray(0, m), R: t.R.subarray(0, m), loop: true };
  }

  function finish(t, name, drive = 0) {
    let peak = 1e-9;
    for (let i = 0; i < t.n; i++) {
      if (drive) { t.L[i] = Math.tanh(t.L[i] * drive) / drive; t.R[i] = Math.tanh(t.R[i] * drive) / drive; }
      peak = Math.max(peak, Math.abs(t.L[i]), Math.abs(t.R[i]));
    }
    const g = 0.891 / peak;
    // A 3 ms fade at each end so loops and slices never click.
    const f = t.loop ? 0 : Math.round(t.sr * 0.003);
    for (let i = 0; i < t.n; i++) {
      const e = f ? Math.min(1, i / f, (t.n - 1 - i) / f) : 1;
      t.L[i] *= g * e; t.R[i] *= g * e;
    }
    return { left: t.L, right: t.R, sampleRate: t.sr, name };
  }

  // ---------- drum voices (mono Float32Arrays)
  function kick(sr, o = {}) {
    const { f0 = 48, f1 = 150, bend = 30, decay = 7, len = 0.5, click = 0.4 } = o;
    const n = Math.round(sr * len), out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const s = i / sr;
      ph += TAU * (f0 + (f1 - f0) * Math.exp(-s * bend)) / sr;
      out[i] = Math.sin(ph) * Math.exp(-s * decay) + click * Math.exp(-s * 900) * (i % 2 ? 1 : -1) * 0.5;
    }
    return out;
  }
  function snare(sr, rnd, o = {}) {
    const { tone = 185, decay = 16, body: bodyDecay = 30, bright = 1, len = 0.3 } = o;
    const n = Math.round(sr * len), out = new Float32Array(n), hp = biquad('hp', 900 * bright, 0.7, sr), lp = biquad('lp', 9000, 0.7, sr);
    for (let i = 0; i < n; i++) {
      const s = i / sr;
      const body = (Math.sin(TAU * tone * s) + 0.5 * Math.sin(TAU * tone * 1.6 * s)) * Math.exp(-s * bodyDecay);
      out[i] = body * 0.5 + lp.run(hp.run(rnd())) * Math.exp(-s * decay) * 0.9;
    }
    return out;
  }
  function clap(sr, rnd, tail = 14) {
    const n = Math.round(sr * 0.35), out = new Float32Array(n), bp = biquad('bp', 1300, 1.2, sr);
    for (let i = 0; i < n; i++) {
      const s = i / sr;
      let env = Math.exp(-s * tail) * 0.6;
      for (const d of [0, 0.011, 0.022]) if (s >= d) env += Math.exp(-(s - d) * 160);
      out[i] = bp.run(rnd()) * env * 1.6;
    }
    return out;
  }
  // 808-style metal: six square oscillators at inharmonic ratios, high-passed.
  function hat(sr, rnd, open = false, decay = open ? 9 : 55) {
    const n = Math.round(sr * (open ? 0.42 : 0.08)), out = new Float32Array(n), hp = biquad('hp', 7000, 0.8, sr), hp2 = biquad('hp', 7000, 0.8, sr);
    const fs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 1.7);
    for (let i = 0; i < n; i++) {
      const s = i / sr;
      let m = 0; for (const f of fs) m += Math.sin(TAU * f * s) > 0 ? 1 : -1;
      out[i] = hp2.run(hp.run(m * 0.12 + rnd() * 0.5)) * Math.exp(-s * decay);
    }
    return out;
  }
  function shaker(sr, rnd) {
    const n = Math.round(sr * 0.07), out = new Float32Array(n), bp = biquad('bp', 6500, 1.5, sr);
    for (let i = 0; i < n; i++) { const s = i / sr; out[i] = bp.run(rnd()) * Math.min(1, s * 300) * Math.exp(-s * 60); }
    return out;
  }
  function cowbell(sr) {
    const n = Math.round(sr * 0.35), out = new Float32Array(n), bp = biquad('bp', 800, 3, sr);
    for (let i = 0; i < n; i++) {
      const s = i / sr, sq = (f) => (Math.sin(TAU * f * s) > 0 ? 1 : -1);
      out[i] = bp.run(sq(540) + sq(800)) * (Math.exp(-s * 40) * 0.6 + Math.exp(-s * 9) * 0.4);
    }
    return out;
  }
  function tom(sr, f) {
    const n = Math.round(sr * 0.5), out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) { const s = i / sr; ph += TAU * f * (1 + 0.6 * Math.exp(-s * 25)) / sr; out[i] = Math.sin(ph) * Math.exp(-s * 8); }
    return out;
  }

  // Step sequencer: 16ths, with swing on the off-16ths.
  function steps(t, bpm, bars, swing, hits) {
    const st = 60 / bpm / 4;
    for (let bar = 0; bar < bars; bar++) {
      for (const [voice, pattern, gain = 1, pan = 0] of hits) {
        const p = Array.isArray(pattern[0]) ? pattern[bar % pattern.length] : pattern;
        for (const step of p) {
          const s = typeof step === 'number' ? step : step[0], g = typeof step === 'number' ? 1 : step[1];
          const time = (bar * 16 + s) * st + (s % 2 ? st * (swing - 0.5) * 2 : 0);
          t.add(time, typeof voice === 'function' ? voice(s, bar) : voice, gain * g, pan);
        }
      }
    }
  }

  const SOUNDS = {
    'funk-break': {
      name: 'Funk break', group: 'Drums', kind: 'loop', bpm: 96, note: 'Two bars with ghost notes. Good for slicing.',
      make(sr) {
        const r = rng(11), t = track(sr, 60 / 96 * 8);
        // Dry and tight, as breaks for chopping are: every hit dies away before the next.
        const K = kick(sr, { f0: 52, f1: 140, decay: 20, len: 0.3 }), S = snare(sr, r, { decay: 28, body: 40 }), G = snare(sr, r, { decay: 45, body: 60 }), H = hat(sr, r, false, 120), O = hat(sr, r, true, 24);
        steps(t, 96, 2, 0.57, [
          [K, [[0, 3, 7, 10], [0, 3, 8, 10, 11]]],
          [S, [4, 12], 0.95, 0.05], [G, [[6, 9, 15], [7, 9, 14]], 0.25, 0.05],
          [H, [0, 2, 4, 6, 8, 10, 12].map((s) => [s, s % 4 ? 0.5 : 0.8]), 0.5, -0.25], [O, [14], 0.45, -0.25],
        ]);
        return finish(t, this.name, 1.4);
      },
    },
    'jungle-break': {
      name: 'Jungle break', group: 'Drums', kind: 'loop', bpm: 170, note: 'A fast chopped break, the classic thing to slice.',
      make(sr) {
        const r = rng(23), t = track(sr, 60 / 170 * 8);
        const K = kick(sr, { f0: 60, f1: 170, decay: 34, len: 0.16 }), S = snare(sr, r, { tone: 210, decay: 42, body: 60, bright: 1.3, len: 0.16 }), H = hat(sr, r, false, 200), O = hat(sr, r, true, 40);
        steps(t, 170, 2, 0.5, [
          [K, [[0, 2, 10, 11], [0, 2, 10]]],
          [S, [[4, 7, 9, 14], [4, 7, 9, 12, 15]], 1, 0.1],
          [H, [0, 2, 4, 6, 8, 10, 12].map((s) => [s, 0.6]), 0.45, -0.3], [O, [[14], []], 0.4, -0.3],
        ]);
        return finish(t, this.name, 1.8);
      },
    },
    'house-groove': {
      name: 'House groove', group: 'Drums', kind: 'loop', bpm: 124, note: 'Four on the floor, offbeat hats, a shaker.',
      make(sr) {
        const r = rng(31), t = track(sr, 60 / 124 * 8);
        const K = kick(sr, { f0: 46, f1: 120, decay: 16, len: 0.3 }), C = clap(sr, r, 30), O = hat(sr, r, true, 22), Sh = shaker(sr, r);
        steps(t, 124, 2, 0.54, [
          [K, [0, 4, 8, 12]], [C, [4, 12], 0.8, 0.1], [O, [2, 6, 10, 14], 0.35, 0.3],
          [Sh, [3, 7, 11, 15], 0.3, -0.35],
        ]);
        return finish(t, this.name, 1.2);
      },
    },
    'electro-808': {
      name: '808 electro', group: 'Drums', kind: 'loop', bpm: 110, note: 'Long boom, claps, cowbell and a tom fill.',
      make(sr) {
        const r = rng(43), t = track(sr, 60 / 110 * 8);
        const B = kick(sr, { f0: 44, f1: 90, bend: 18, decay: 7, len: 0.55, click: 0.2 }), C = clap(sr, r, 30), Cb = cowbell(sr), H = hat(sr, r, false, 120);
        steps(t, 110, 2, 0.5, [
          [B, [[0, 6, 10], [0, 6, 9]]], [C, [4, 12], 0.75], [Cb, [[3, 11], [3, 11, 14]], 0.3, 0.4],
          [H, [2, 8, 14].map((s) => [s, 0.8]), 0.35, -0.3],
          [(s) => tom(sr, { 13: 160, 14: 130, 15: 100 }[s]), [[], [13, 14, 15]], 0.7, 0],
        ]);
        return finish(t, this.name, 1.5);
      },
    },
    'drum-hits': {
      name: 'Drum hits', group: 'Drums', kind: 'hits', bpm: null, note: 'Eight separate one-shots in a row: kick, snare, clap, hats, cowbell, tom, boom.',
      make(sr) {
        const r = rng(57), t = track(sr, 6.4);
        const hits = [kick(sr), snare(sr, r), clap(sr, r), hat(sr, r), hat(sr, r, true), cowbell(sr), tom(sr, 120), kick(sr, { f0: 44, f1: 90, bend: 18, decay: 3, len: 0.75, click: 0.2 })];
        hits.forEach((h, k) => t.add(0.05 + k * 0.8, h, k === 3 ? 0.7 : 1));
        return finish(t, this.name, 1.1);
      },
    },
    'acid-bass': {
      name: 'Acid bass', group: 'Bass', kind: 'loop', bpm: 128, note: 'A squelchy 16th-note line with accents and slides.',
      make(sr) {
        const bpm = 128, st = 60 / bpm / 4, t = track(sr, st * 32);
        // note, accent, slide; null is a rest
        const seq = [[33, 1], [33], [45, 0, 1], [33], null, [36], [33, 1], [43], [33], [31, 1], [33], null, [40, 0, 1], [43], [33, 1], [45]];
        const lp = biquad('lp', 400, 7, sr);
        let ph = 0, freq = hz(33), cut = 400;
        for (let i = 0; i < t.n; i++) {
          const pos = i / sr / st, k = Math.floor(pos) % 16, into = pos - Math.floor(pos), step = seq[k];
          const prev = seq[(k + 15) % 16];
          let gate = 0, target = freq;
          if (step) {
            target = hz(step[0]);
            gate = into < 0.7 || (step[2] && seq[(k + 1) % 16]) ? 1 : 0;
          }
          freq += (target - freq) * (prev && prev[2] ? 0.0015 : 0.5);
          ph = (ph + freq / sr) % 1;
          const env = step ? Math.exp(-into * (step[1] ? 2.2 : 4.5)) : 0;
          if (i % 16 === 0) { cut = 220 + (step && step[1] ? 3200 : 1700) * env + 400 * (0.5 + 0.5 * Math.sin(TAU * i / sr / (st * 32))); lp.set(cut, step && step[1] ? 11 : 7); }
          const v = Math.tanh(lp.run(ph * 2 - 1) * 1.6) * gate * (step && step[1] ? 1 : 0.75);
          t.L[i] = v; t.R[i] = v;
        }
        return finish(t, this.name);
      },
    },
    'electric-piano': {
      name: 'Electric piano', group: 'Keys & plucks', kind: 'loop', bpm: 84, note: 'FM tines over four jazz chords.',
      make(sr) {
        const beat = 60 / 84, t = track(sr, beat * 8 + 1.5);
        const chords = [[50, 53, 57, 60, 64], [43, 53, 57, 59, 64], [48, 52, 55, 59, 62], [45, 52, 55, 61, 65]];
        chords.forEach((ch, c) => ch.forEach((m, j) => {
          const f = hz(m + 12), n = Math.round(sr * 2.6), v = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            const s = i / sr, I = 1.3 * Math.exp(-s * 3) + 0.15;
            v[i] = (Math.sin(TAU * f * s + I * Math.sin(TAU * f * s)) + 0.12 * Math.sin(TAU * f * 14 * s) * Math.exp(-s * 30)) * Math.exp(-s * 1.6) * Math.min(1, s * 400);
          }
          t.add(c * beat * 2 + j * 0.012, v, 0.3, (j / 4 - 0.5) * 0.6);
        }));
        // A gentle stereo tremolo, as the real thing had.
        for (let i = 0; i < t.n; i++) { const p = 0.18 * Math.sin(TAU * 4.5 * i / sr); t.L[i] *= 1 - p; t.R[i] *= 1 + p; }
        return finish(wrap(t, beat * 8), this.name);
      },
    },
    'plucked-arpeggio': {
      name: 'Plucked arpeggio', group: 'Keys & plucks', kind: 'loop', bpm: 100, note: 'A plucked string (Karplus–Strong) over A minor, F, C, G.',
      make(sr) {
        const st = 60 / 100 / 4, t = track(sr, st * 32 + 1), r = rng(71);
        const chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]];
        const shape = [0, 1, 2, 3, 2, 1, 3, 2];
        for (let k = 0; k < 32; k++) {
          const ch = chords[Math.floor(k / 8)], f = hz(ch[shape[k % 8]]), n = Math.round(sr * 1.4), v = new Float32Array(n);
          const len = Math.round(sr / f), line = new Float32Array(len);
          for (let i = 0; i < len; i++) line[i] = r() * 0.9;
          let p = 0;
          for (let i = 0; i < n; i++) { const a = line[p], b = line[(p + 1) % len]; line[p] = 0.4985 * (a + b); v[i] = a; p = (p + 1) % len; }
          t.add(k * st, v, k % 8 === 0 ? 0.9 : 0.65, k % 2 ? 0.35 : -0.35);
        }
        return finish(wrap(t, st * 32), this.name);
      },
    },
    'warm-pad': {
      name: 'Warm pad', group: 'Pads & voices', kind: 'sustain', bpm: null, note: 'Detuned saws swelling into an F major 9 chord.',
      make(sr) {
        const t = track(sr, 7), notes = [41, 53, 57, 60, 64, 67];
        const lpL = biquad('lp', 900, 0.9, sr), lpR = biquad('lp', 900, 0.9, sr);
        const r = rng(83), oscs = notes.flatMap((m) => [-7, 0, 7].map((c) => ({ f: hz(m) * Math.pow(2, c / 1200), pl: r() * 0.5 + 0.5, pr: r() * 0.5 + 0.5, d: c })));
        for (let i = 0; i < t.n; i++) {
          const s = i / sr;
          let l = 0, rr = 0;
          for (const o of oscs) { o.pl = (o.pl + o.f * (1 + o.d * 0.00004) / sr) % 1; o.pr = (o.pr + o.f * (1 - o.d * 0.00004) / sr) % 1; l += o.pl * 2 - 1; rr += o.pr * 2 - 1; }
          if (i % 32 === 0) { const c = 700 + 900 * (0.5 - 0.5 * Math.cos(TAU * s / 7)); lpL.set(c, 0.9); lpR.set(c * 1.05, 0.9); }
          const env = Math.min(1, s / 2) * Math.min(1, (7 - s) / 1.5);
          t.L[i] = lpL.run(l) * env; t.R[i] = lpR.run(rr) * env;
        }
        return finish(t, this.name);
      },
    },
    'choir-aah': {
      name: 'Choir aah', group: 'Pads & voices', kind: 'sustain', bpm: null, note: 'Three voices singing "aah", made with formant filters.',
      make(sr) {
        const t = track(sr, 6.5), voices = [[57, -0.4], [60, 0], [64, 0.4]];
        const formants = [[800, 80, 1], [1150, 90, 0.5], [2900, 120, 0.025], [3900, 130, 0.01]];
        voices.forEach(([m, pan], vi) => {
          const n = t.n, v = new Float32Array(n), f0 = hz(m), fs = formants.map(([f, bw, g]) => [biquad('bp', f, f / bw, sr), g]);
          let ph = 0;
          for (let i = 0; i < n; i++) {
            const s = i / sr, f = f0 * (1 + 0.005 * Math.sin(TAU * (5.2 + vi * 0.3) * s + vi) * Math.min(1, s));
            ph = (ph + f / sr) % 1;
            // A soft glottal pulse: a raised cosine, narrow in the period.
            const src = ph < 0.35 ? 0.5 - 0.5 * Math.cos(TAU * ph / 0.35) : 0;
            let y = 0; for (const [bq, g] of fs) y += bq.run(src) * g;
            v[i] = y * Math.min(1, s / 0.8) * Math.min(1, (6.5 - s) / 1.2);
          }
          t.add(0, v, 1, pan);
        });
        return finish(t, this.name);
      },
    },
    'glass-bells': {
      name: 'Glass bells', group: 'Bells & FX', kind: 'loop', bpm: 90, note: 'FM bells on a pentatonic tune, with long rings.',
      make(sr) {
        const beat = 60 / 90, t = track(sr, beat * 8 + 2.5);
        const tune = [76, 79, 81, 84, 81, 79, 74, 76];
        tune.forEach((m, k) => {
          const f = hz(m), n = Math.round(sr * 3), v = new Float32Array(n);
          for (let i = 0; i < n; i++) { const s = i / sr, I = 4 * Math.exp(-s * 2.5); v[i] = Math.sin(TAU * f * s + I * Math.sin(TAU * f * 3.5 * s)) * Math.exp(-s * 1.3); }
          t.add(k * beat, v, 0.6, ((k * 3) % 5) / 2 - 1);
        });
        return finish(wrap(t, beat * 8), this.name);
      },
    },
    'riser-crash': {
      name: 'Riser and crash', group: 'Bells & FX', kind: 'fx', bpm: null, note: 'Noise sweeping up for four seconds, then a crash.',
      make(sr) {
        const t = track(sr, 6), r = rng(97), bpL = biquad('bp', 200, 4, sr), bpR = biquad('bp', 200, 4, sr), hp = biquad('hp', 3000, 0.7, sr);
        for (let i = 0; i < t.n; i++) {
          const s = i / sr;
          if (s < 4) {
            if (i % 32 === 0) { const f = 200 * Math.pow(40, s / 4); bpL.set(f, 4); bpR.set(f * 1.07, 4); }
            const g = Math.pow(s / 4, 2);
            t.L[i] += bpL.run(r()) * g * 2; t.R[i] += bpR.run(r()) * g * 2;
          }
          if (s >= 4) { const c = hp.run(r()) * Math.exp(-(s - 4) * 2.2) * 0.9; t.L[i] += c; t.R[i] += c * 0.9 + r() * 0.02; }
        }
        return finish(t, this.name);
      },
    },
  };

  const list = Object.entries(SOUNDS).map(([id, s]) => ({ id, name: s.name, group: s.group, kind: s.kind, bpm: s.bpm, note: s.note }));
  const cache = {};

  function render(id, sampleRate) {
    const s = SOUNDS[id];
    if (!s) throw new Error('No sound called ' + id);
    const key = id + '@' + sampleRate;
    return cache[key] || (cache[key] = s.make.call(s, sampleRate));
  }

  function toBuffer(ctx, id) {
    const r = render(id, ctx.sampleRate), buf = ctx.createBuffer(2, r.left.length, ctx.sampleRate);
    buf.getChannelData(0).set(r.left);
    buf.getChannelData(1).set(r.right);
    return buf;
  }

  root.SoundKit = { list, render, toBuffer };
})(typeof globalThis !== 'undefined' ? globalThis : this);
