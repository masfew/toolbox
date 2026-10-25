import { describe, expect, it } from 'vitest';
import { recognize, type Pt, type Recognized } from '../src/tools/recognize';

// ---------- Hand-drawn-like strokes ----------
// Each one is a path with a hand's faults: a slow wobble, a little shake at every sample, uneven
// spacing between samples, a gap or an overshoot where a closed shape meets itself. A seeded
// generator keeps them the same on every run.

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Hand {
  /** Slow drift off the true path, as a share of the stroke's size. */
  wobble?: number;
  /** Shake at each sample, in pixels. */
  shake?: number;
  seed?: number;
}

/** Points `t` from 0 to 1 along a path function, spaced unevenly like mouse samples, with the hand's faults. */
function hand(path: (t: number) => Pt, size: number, o: Hand = {}, samples = 90): Pt[] {
  const r = rng(o.seed ?? 7);
  const wobble = (o.wobble ?? 0.018) * size;
  const shake = o.shake ?? 0.6;
  const waves = [0, 1, 2].map((i) => ({ f: 1.5 + i * 1.7 + r() * 0.6, px: r() * 6.28, py: r() * 6.28, a: wobble / (1 + i) }));
  const out: Pt[] = [];
  let t = 0;
  while (t < 1) {
    const p = path(t);
    let dx = 0;
    let dy = 0;
    for (const w of waves) {
      dx += Math.sin(t * w.f * 6.28 + w.px) * w.a;
      dy += Math.cos(t * w.f * 6.28 + w.py) * w.a;
    }
    out.push({ x: p.x + dx + (r() - 0.5) * shake * 2, y: p.y + dy + (r() - 0.5) * shake * 2 });
    t += (0.5 + r()) / samples;
  }
  const end = path(1);
  out.push({ x: end.x + (r() - 0.5) * shake, y: end.y + (r() - 0.5) * shake });
  return out;
}

/** A path through corner points, `t` walking along it by length. */
function through(corners: Pt[]): (t: number) => Pt {
  const lens = corners.slice(1).map((p, i) => Math.hypot(p.x - corners[i].x, p.y - corners[i].y));
  const total = lens.reduce((a, b) => a + b, 0);
  return (t) => {
    let d = Math.min(1, Math.max(0, t)) * total;
    for (let i = 0; i < lens.length; i++) {
      if (d <= lens[i] || i === lens.length - 1) {
        const k = lens[i] ? Math.min(1, d / lens[i]) : 0;
        return { x: corners[i].x + (corners[i + 1].x - corners[i].x) * k, y: corners[i].y + (corners[i + 1].y - corners[i].y) * k };
      }
      d -= lens[i];
    }
    return corners[corners.length - 1];
  };
}

const line = (a: Pt, b: Pt, o?: Hand) => hand(through([a, b]), Math.hypot(b.x - a.x, b.y - a.y), o);

/** An arrow from `tail` to `tip` with the V drawn after the shaft, or before it. */
function arrow(tail: Pt, tip: Pt, o: Hand & { barb?: number; spread?: number; vFirst?: boolean } = {}): Pt[] {
  const L = Math.hypot(tip.x - tail.x, tip.y - tail.y);
  const back = Math.atan2(tail.y - tip.y, tail.x - tip.x);
  const barb = (o.barb ?? 0.28) * L;
  const spread = ((o.spread ?? 30) * Math.PI) / 180;
  const c = { x: tip.x + Math.cos(back + spread) * barb, y: tip.y + Math.sin(back + spread) * barb };
  const d = { x: tip.x + Math.cos(back - spread) * barb, y: tip.y + Math.sin(back - spread) * barb };
  const corners = o.vFirst ? [c, tip, d, tip, tail] : [tail, tip, c, tip, d];
  return hand(through(corners), L, o, 130);
}

/** A rectangle drawn round from its top-left corner. `gap` stops short of the start (share of the last side); a negative one runs past it along the first side. */
function rect(x: number, y: number, w: number, h: number, o: Hand & { gap?: number; ccw?: boolean; round?: number } = {}): Pt[] {
  const gap = o.gap ?? 0.03;
  const r = Math.min(w, h) * (o.round ?? 0);
  const cw: Pt[] = r
    ? [{ x: x + r, y }, { x: x + w - r, y }, { x: x + w, y: y + r }, { x: x + w, y: y + h - r }, { x: x + w - r, y: y + h }, { x: x + r, y: y + h }, { x, y: y + h - r }, { x, y: y + r }]
    : [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const start = cw[0];
  const pts = [...cw];
  if (gap >= 0) {
    // Back up the last side, stopping short.
    const last = pts[pts.length - 1];
    pts.push({ x: last.x + (start.x - last.x) * (1 - gap), y: last.y + (start.y - last.y) * (1 - gap) });
  } else {
    pts.push(start, { x: start.x + (cw[1].x - start.x) * -gap * 2, y: start.y + (cw[1].y - start.y) * -gap * 2 });
  }
  const drawn = o.ccw ? pts.map((p) => ({ x: x + w - (p.x - x), y: p.y })) : pts;
  return hand(through(drawn), Math.max(w, h), o, 150);
}

function ellipse(cx: number, cy: number, rx: number, ry: number, o: Hand & { gap?: number; turns?: number; ccw?: boolean; start?: number } = {}): Pt[] {
  const turns = o.turns ?? 1.04 - (o.gap ?? 0);
  const s = o.start ?? -Math.PI / 2;
  const dir = o.ccw ? -1 : 1;
  return hand((t) => ({ x: cx + Math.cos(s + dir * t * turns * Math.PI * 2) * rx, y: cy + Math.sin(s + dir * t * turns * Math.PI * 2) * ry }), Math.max(rx, ry) * 2, o, 140);
}

function arc(cx: number, cy: number, r: number, from: number, sweep: number, o?: Hand): Pt[] {
  return hand((t) => ({ x: cx + Math.cos(from + t * sweep) * r, y: cy + Math.sin(from + t * sweep) * r }), r * 2, o, 100);
}

function scribble(seed: number, n = 14, size = 200): Pt[] {
  const r = rng(seed);
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: 100 + r() * size, y: 100 + r() * size });
  return hand(through(pts), size, { seed, shake: 1 }, 400);
}

/** A letter drawn as a path through corner points, 160 pixels tall. */
const letter = (corners: [number, number][], o?: Hand) => hand(through(corners.map(([x, y]) => ({ x: 100 + x * 160, y: 100 + y * 160 }))), 160, o, 160);

const kind = (r: Recognized | null) => r?.kind ?? null;

describe('rough strokes that become shapes', () => {
  it('finds a straight line, at any angle and speed', () => {
    const ends: [Pt, Pt][] = [
      [{ x: 40, y: 50 }, { x: 340, y: 60 }],
      [{ x: 300, y: 300 }, { x: 80, y: 70 }],
      [{ x: 50, y: 400 }, { x: 60, y: 120 }],
      [{ x: 100, y: 100 }, { x: 160, y: 130 }],
      [{ x: 500, y: 90 }, { x: 40, y: 380 }],
    ];
    ends.forEach(([a, b], i) => {
      const r = recognize(line(a, b, { seed: i + 1 }));
      expect(kind(r)).toBe('line');
      const l = r as Extract<Recognized, { kind: 'line' }>;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      expect(Math.hypot(l.a.x - a.x, l.a.y - a.y)).toBeLessThan(len * 0.05);
      expect(Math.hypot(l.b.x - b.x, l.b.y - b.y)).toBeLessThan(len * 0.05);
    });
  });

  it('finds an arrow, drawn shaft first or V first, either way up', () => {
    const cases: [Pt, Pt, boolean][] = [
      [{ x: 60, y: 300 }, { x: 360, y: 100 }, false],
      [{ x: 60, y: 300 }, { x: 360, y: 100 }, true],
      [{ x: 400, y: 80 }, { x: 80, y: 90 }, false],
      [{ x: 200, y: 60 }, { x: 210, y: 360 }, false],
      [{ x: 300, y: 380 }, { x: 140, y: 120 }, true],
    ];
    cases.forEach(([tail, tip, vFirst], i) => {
      const r = recognize(arrow(tail, tip, { vFirst, seed: i + 3 }));
      expect(kind(r)).toBe('arrow');
      const a = r as Extract<Recognized, { kind: 'arrow' }>;
      expect(Math.hypot(a.b.x - tip.x, a.b.y - tip.y)).toBeLessThan(14);
      expect(Math.hypot(a.a.x - tail.x, a.a.y - tail.y)).toBeLessThan(14);
    });
  });

  it('finds a rectangle, in either direction, tidy or with a gap or overshoot', () => {
    const boxes: [number, number, number, number, object][] = [
      [60, 60, 260, 160, {}],
      [60, 60, 260, 160, { ccw: true }],
      [100, 80, 180, 180, { gap: 0.1 }],
      [100, 80, 300, 120, { gap: -0.1 }],
      [40, 40, 400, 90, { seed: 11 }],
      [120, 100, 200, 200, { round: 0.12, seed: 5 }],
    ];
    boxes.forEach(([x, y, w, h, o], i) => {
      const r = recognize(rect(x, y, w, h, { seed: i + 1, ...o }));
      expect(kind(r)).toBe('rectangle');
      const b = r as Extract<Recognized, { w: number }>;
      const tol = Math.max(w, h) * 0.07;
      expect(Math.abs(b.x - x)).toBeLessThan(tol);
      expect(Math.abs(b.y - y)).toBeLessThan(tol);
      expect(Math.abs(b.w - w)).toBeLessThan(tol * 1.5);
      expect(Math.abs(b.h - h)).toBeLessThan(tol * 1.5);
    });
  });

  it('finds an ellipse or a circle, in either direction, closed or with a gap or overshoot', () => {
    const shapes: [number, number, number, number, object][] = [
      [200, 200, 100, 100, {}],
      [200, 200, 100, 100, { ccw: true, start: 0.3 }],
      [200, 200, 150, 80, { gap: 0.06 }],
      [200, 200, 80, 150, { turns: 1.12 }],
      [300, 150, 60, 60, { seed: 9 }],
      [200, 200, 220, 110, { start: 2.2, seed: 4 }],
    ];
    shapes.forEach(([cx, cy, rx, ry, o], i) => {
      const r = recognize(ellipse(cx, cy, rx, ry, { seed: i + 1, ...o }));
      expect(kind(r)).toBe('ellipse');
      const b = r as Extract<Recognized, { w: number }>;
      expect(Math.abs(b.x + b.w / 2 - cx)).toBeLessThan(rx * 0.1);
      expect(Math.abs(b.y + b.h / 2 - cy)).toBeLessThan(ry * 0.1);
      expect(Math.abs(b.w - rx * 2)).toBeLessThan(rx * 0.25);
      expect(Math.abs(b.h - ry * 2)).toBeLessThan(ry * 0.25);
    });
  });
});

describe('strokes that stay strokes', () => {
  it('leaves scribbles alone', () => {
    for (let s = 1; s <= 30; s++) expect(kind(recognize(scribble(s, 6 + (s % 12))))).toBeNull();
  });

  it('leaves letters alone', () => {
    const letters: Record<string, [number, number][]> = {
      L: [[0, 0], [0, 1], [0.7, 1]],
      V: [[0, 0], [0.4, 1], [0.8, 0]],
      Z: [[0, 0], [0.7, 0], [0, 1], [0.7, 1]],
      N: [[0, 1], [0, 0], [0.7, 1], [0.7, 0]],
      M: [[0, 1], [0, 0], [0.4, 0.6], [0.8, 0], [0.8, 1]],
      W: [[0, 0], [0.2, 1], [0.4, 0.3], [0.6, 1], [0.8, 0]],
      E: [[0.7, 0], [0, 0], [0, 0.5], [0.5, 0.5], [0, 0.5], [0, 1], [0.7, 1]],
      F: [[0.7, 0], [0, 0], [0, 1], [0, 0.5], [0.5, 0.5]],
      A: [[0, 1], [0.4, 0], [0.8, 1], [0.7, 0.62], [0.1, 0.62]],
      T: [[0, 0], [0.8, 0], [0.4, 0], [0.4, 1]],
      check: [[0, 0.6], [0.25, 1], [0.9, 0]],
      step: [[0, 1], [0.4, 1], [0.4, 0.5], [0.8, 0.5], [0.8, 0]],
    };
    for (const [name, corners] of Object.entries(letters)) {
      for (const seed of [1, 2, 3]) expect(kind(recognize(letter(corners, { seed }))), `${name} ${seed}`).toBeNull();
    }
    // Curved letters: S, C, U, a loop, a wave.
    const S = hand((t) => ({ x: 200 + Math.sin(t * Math.PI * 2) * 60 * (t < 0.5 ? 1 : 1), y: 100 + t * 200 }), 200);
    expect(kind(recognize(S))).toBeNull();
    expect(kind(recognize(hand((t) => ({ x: 100 + t * 400, y: 200 + Math.sin(t * Math.PI * 6) * 40 }), 400)))).toBeNull();
  });

  it('leaves open curves alone', () => {
    for (const [from, sweep] of [[0.3, 2.4], [0, 3.14], [1, 4.0], [0, 4.7], [2, 5.0]]) {
      for (const seed of [1, 2]) expect(kind(recognize(arc(200, 200, 100, from, sweep, { seed }))), `arc ${from} ${sweep}`).toBeNull();
    }
    // A gentle bow is not a line, and a "C" is not a circle.
    expect(kind(recognize(hand((t) => ({ x: 100 + t * 300, y: 200 - Math.sin(t * Math.PI) * 60 }), 300)))).toBeNull();
    expect(kind(recognize(ellipse(200, 200, 100, 100, { turns: 0.7 })))).toBeNull();
  });

  it('leaves other closed shapes alone', () => {
    // A triangle, a figure eight, and a line drawn out and back.
    expect(kind(recognize(hand(through([{ x: 200, y: 60 }, { x: 330, y: 300 }, { x: 70, y: 300 }, { x: 200, y: 60 }]), 300)))).toBeNull();
    expect(kind(recognize(hand((t) => ({ x: 200 + Math.sin(t * Math.PI * 4) * 80, y: 200 + Math.sin(t * Math.PI * 2) * 100 }), 200)))).toBeNull();
    expect(kind(recognize(hand(through([{ x: 80, y: 100 }, { x: 380, y: 110 }, { x: 82, y: 103 }]), 300)))).toBeNull();
  });

  it('leaves tiny marks and dots alone', () => {
    expect(recognize([])).toBeNull();
    expect(recognize([{ x: 5, y: 5 }])).toBeNull();
    expect(recognize([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }])).toBeNull();
    expect(recognize(line({ x: 10, y: 10 }, { x: 18, y: 12 }, { wobble: 0, shake: 0.05 }))).toBeNull();
    expect(recognize(ellipse(50, 50, 4, 4))).toBeNull();
  });

  it('honours a smaller or bigger size to ignore', () => {
    const small = line({ x: 10, y: 10 }, { x: 18, y: 12 }, { wobble: 0, shake: 0.05 });
    expect(recognize(small)).toBeNull();
    expect(kind(recognize(small, { min: 4 }))).toBe('line');
    expect(recognize(line({ x: 0, y: 0 }, { x: 100, y: 3 }), { min: 200 })).toBeNull();
  });
});

describe('how often it is right', () => {
  const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
  const rate = (make: (seed: number) => Pt[], want: string) => seeds.filter((seed) => kind(recognize(make(seed))) === want).length / seeds.length;
  const r = (seed: number, salt: number) => rng(seed * 977 + salt)();

  it('recognises most shapes drawn with a shaky hand', () => {
    const hands = (seed: number): Hand => ({ seed, wobble: 0.012 + r(seed, 1) * 0.02, shake: 0.4 + r(seed, 2) * 1.2 });
    const rates = {
      line: rate((s) => line({ x: 50 + r(s, 3) * 100, y: 50 + r(s, 4) * 100 }, { x: 250 + r(s, 5) * 300, y: 100 + r(s, 6) * 300 }, hands(s)), 'line'),
      arrow: rate((s) => arrow({ x: 60, y: 300 }, { x: 260 + r(s, 7) * 200, y: 60 + r(s, 8) * 250 }, { ...hands(s), vFirst: s % 2 === 0, spread: 22 + r(s, 9) * 20, barb: 0.2 + r(s, 10) * 0.15 }), 'arrow'),
      rectangle: rate((s) => rect(60, 60, 120 + r(s, 11) * 300, 90 + r(s, 12) * 250, { ...hands(s), gap: (r(s, 13) - 0.4) * 0.3, ccw: s % 2 === 0, round: s % 3 === 0 ? 0.1 : 0 }), 'rectangle'),
      ellipse: rate((s) => ellipse(300, 250, 60 + r(s, 14) * 160, 60 + r(s, 15) * 160, { ...hands(s), turns: 0.93 + r(s, 16) * 0.2, ccw: s % 2 === 0, start: r(s, 17) * 6 }), 'ellipse'),
    };
    console.log('recognised:', JSON.stringify(rates));
    for (const [name, v] of Object.entries(rates)) expect(v, name).toBeGreaterThanOrEqual(0.9);
  });

  it('never turns a scribble, a letter or an open curve into a shape', () => {
    const wrong: Record<string, number> = {};
    const count = (name: string, make: (seed: number) => Pt[], n = 120) => {
      let bad = 0;
      for (let s = 1; s <= n; s++) {
        if (recognize(make(s))) bad++;
      }
      wrong[name] = bad;
    };
    // Corners picked at random; a run that happens to lie nearly straight is a fair line, so it's left out.
    const corners = (s: number, n: number) => {
      const rr = rng(s * 31 + n);
      return Array.from({ length: n }, () => ({ x: 80 + rr() * 300, y: 80 + rr() * 300 }));
    };
    const straightish = (c: Pt[]) => {
      const a = c[0];
      const b = c[c.length - 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const path = c.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - c[i].x, p.y - c[i].y), 0);
      return path < len * 1.3 && c.every((p) => Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len < len * 0.15);
    };
    const polyline = (s: number, n: number) => {
      const c = corners(s, n);
      return straightish(c) ? [] : hand(through(c), 300, { seed: s }, 200);
    };
    count('scribble', (s) => scribble(s, 6 + (s % 16)));
    count('3 corners', (s) => polyline(s, 3));
    count('4 corners', (s) => polyline(s, 4));
    count('5 corners', (s) => polyline(s, 5));
    count('6 corners', (s) => polyline(s, 6));
    count('arc', (s) => arc(250, 250, 80 + r(s, 1) * 120, r(s, 2) * 6.28, 0.6 + r(s, 3) * 4.3, { seed: s }));
    count('bow', (s) => hand((t) => ({ x: 100 + t * 300, y: 250 - Math.sin(t * Math.PI) * (30 + r(s, 4) * 60) }), 300, { seed: s }));
    count('wave', (s) => hand((t) => ({ x: 100 + t * 400, y: 200 + Math.sin(t * Math.PI * (2 + (s % 5))) * (30 + r(s, 5) * 40) }), 400, { seed: s }));
    console.log('wrongly turned into shapes:', JSON.stringify(wrong));
    for (const [name, v] of Object.entries(wrong)) expect(v, name).toBe(0);
  });
});

describe('the matcher is quick', () => {
  it('takes well under a millisecond for an ordinary stroke, and a few for a very long one', () => {
    const ordinary = ellipse(200, 200, 100, 100);
    const long = hand((t) => ({ x: 2000 + Math.cos(t * 75) * 1500, y: 2000 + Math.sin(t * 75) * 900 }), 3000, {}, 20000);
    const time = (pts: Pt[], reps: number) => {
      recognize(pts);
      const t0 = performance.now();
      for (let i = 0; i < reps; i++) recognize(pts);
      return (performance.now() - t0) / reps;
    };
    const a = time(ordinary, 200);
    const b = time(long, 50);
    console.log(`recognize: ${ordinary.length} points ${a.toFixed(4)} ms, ${long.length} points ${b.toFixed(4)} ms`);
    expect(a).toBeLessThan(1);
    expect(b).toBeLessThan(5);
  });
});
