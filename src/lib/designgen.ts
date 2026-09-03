// ThreadDrop design generator — text prompt in, apparel graphic out.
//
// Local mode (default): pure TypeScript, zero packages. Deterministic — the
// same prompt always renders the same SVG — via an FNV-1a hash that picks a
// palette and a layout style. Output is a 2400x2400 typographic print
// (large wearable caps + small caption), transparent background so it sits
// on any garment color.
//
// Remote seam: if IMAGE_GEN_API_URL and IMAGE_GEN_API_KEY are both set, the
// prompt is sent there instead; the local SVG is the fallback if the remote
// call fails. The remote contract is intentionally loose (see generateRemote).

export type DesignEngine = "local" | "remote";

export interface DesignOutput {
  /** Raw SVG markup when produced locally (or returned by the remote API). */
  svg?: string;
  /** A URL (https or data:) when the design lives elsewhere. */
  imageUrl?: string;
  engine: DesignEngine;
}

// ---------- deterministic hash ----------

function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------- palettes (ink + accent, chosen to read on light garments) ----------

const PALETTES: Array<{ ink: string; accent: string }> = [
  { ink: "#111827", accent: "#dc2626" }, // charcoal + red
  { ink: "#111827", accent: "#ea580c" }, // charcoal + orange
  { ink: "#1e3a5f", accent: "#f59e0b" }, // navy + amber
  { ink: "#14532d", accent: "#d97706" }, // forest + amber
  { ink: "#4c1d95", accent: "#06b6d4" }, // deep violet + cyan
  { ink: "#7f1d1d", accent: "#fbbf24" }, // burgundy + gold
  { ink: "#0f172a", accent: "#0ea5e9" }, // slate + sky
  { ink: "#1f2937", accent: "#16a34a" }, // graphite + green
];

const STYLES = 5; // layout variants, picked by hash

const FONT_STACK =
  "'Archivo Black','Arial Black','Helvetica Neue',Impact,sans-serif";

const VIEW = 2400;
const CENTER_X = VIEW / 2;
const CONTENT_W = 2000; // usable width inside the margins

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function textEl(
  s: string,
  x: number,
  y: number,
  fs: number,
  fill: string,
  tracking = 0
): string {
  const extra = tracking ? ` letter-spacing="${Math.round(tracking)}"` : "";
  return (
    `<text x="${x}" y="${Math.round(y)}" fill="${fill}"` +
    ` font-family="${FONT_STACK}" font-weight="900" font-size="${Math.round(fs)}"` +
    ` text-anchor="middle"${extra}>${esc(s)}</text>`
  );
}

/** Average glyph-width factor for heavy sans caps (width ≈ factor * fs * len). */
function fitFontSize(text: string, maxFs: number, factor: number, maxW: number): number {
  if (!text.length) return maxFs;
  return Math.max(60, Math.min(maxFs, Math.floor(maxW / (factor * text.length))));
}

function starburst(cx: number, cy: number, r: number, color: string, rotDeg: number): string {
  let out = "";
  const rays = 12;
  for (let i = 0; i < rays; i++) {
    const a = ((rotDeg + (i * 360) / rays) * Math.PI) / 180;
    const x1 = cx + Math.cos(a) * r * 0.34;
    const y1 = cy + Math.sin(a) * r * 0.34;
    const x2 = cx + Math.cos(a) * r;
    const y2 = cy + Math.sin(a) * r;
    out +=
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"` +
      ` stroke="${color}" stroke-width="30" stroke-linecap="round"/>`;
  }
  return out;
}

function diamond(cx: number, cy: number, size: number, color: string): string {
  const half = size / 2;
  return (
    `<rect x="${cx - half}" y="${cy - half}" width="${size}" height="${size}"` +
    ` fill="${color}" transform="rotate(45 ${cx} ${cy})"/>`
  );
}

/** Split one very long word into two balanced display lines. */
function splitLongWord(word: string): [string, string] | null {
  if (word.length < 14) return null;
  const cut = Math.ceil(word.length / 2);
  return [word.slice(0, cut), word.slice(cut)];
}

interface HeadlineLine {
  text: string;
  fs: number;
}

/**
 * Render the local deterministic design for a prompt as SVG markup.
 * 2400x2400 viewBox, transparent background, large wearable typography.
 */
export function renderLocalDesignSvg(prompt: string): string {
  const raw = prompt.trim().replace(/\s+/g, " ");
  const h = hash32(raw.toLowerCase() || "drop");
  const pal = PALETTES[h % PALETTES.length];
  const style = Math.floor(h / PALETTES.length) % STYLES;
  const rot = (h >>> 7) % 30;

  const sanitize = (s: string): string =>
    s.toUpperCase().replace(/[^A-Z0-9 .,!?&'\-:]/g, "").trim();
  const words = raw.split(" ").map(sanitize).filter(Boolean);

  // Headline: the longest word (ties → first). Two-word prompts stack both.
  // Longer prompts promote one word to the headline and park the rest in a
  // small caption line — big wearable type, not a paragraph.
  let headlineWords: string[];
  let subText: string | null = null;
  if (words.length === 0) {
    headlineWords = ["DROP"];
  } else if (words.length <= 2) {
    headlineWords = words;
  } else {
    const head = words.reduce((a, b) => (b.length > a.length ? b : a), words[0]);
    headlineWords = [head];
    const rest = words.filter((w) => w !== head);
    let s = rest.join(" ");
    if (s.length > 52) {
      const cut = s.slice(0, 52);
      const lastSpace = cut.lastIndexOf(" ");
      s = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim() + "…";
    }
    subText = s || null;
  }

  // Very long single headline words split into two lines.
  if (headlineWords.length === 1 && headlineWords[0].length >= 14) {
    const split = splitLongWord(headlineWords[0]);
    if (split) headlineWords = split;
  }

  const headline: HeadlineLine[] = headlineWords.map((w) => ({
    text: w,
    fs: fitFontSize(w, 560, 0.62, CONTENT_W),
  }));

  let subFs = 0;
  if (subText) {
    subFs = fitFontSize(subText, 110, 0.92, 1800);
  }

  const widest = (lines: HeadlineLine[]): number =>
    Math.max(...lines.map((l) => l.fs * 0.62 * l.text.length));

  // Compose vertical blocks top→bottom, then center the whole stack.
  interface Block {
    h: number;
    draw: (top: number) => string;
  }
  const blocks: Block[] = [];
  const headlineW = Math.min(CONTENT_W, Math.max(700, widest(headline)));

  if (style === 2) {
    blocks.push({ h: 440, draw: (t) => starburst(CENTER_X, t + 170, 170, pal.accent, rot) });
  }
  for (const ln of headline) {
    const gap = Math.round(ln.fs * 0.06);
    blocks.push({
      h: ln.fs + gap,
      draw: (t) =>
        textEl(ln.text, CENTER_X, t + ln.fs * 0.8, ln.fs, pal.ink, -ln.fs * 0.02),
    });
  }
  if (style === 1) {
    blocks.push({ h: 190, draw: (t) => diamond(CENTER_X, t + 70, 52, pal.accent) });
  }
  if (style === 0) {
    const barW = Math.max(600, Math.min(CONTENT_W, Math.round(headlineW * 0.7)));
    blocks.push({
      h: 240,
      draw: (t) =>
        `<rect x="${CENTER_X - barW / 2}" y="${t + 60}" width="${barW}" height="110" fill="${pal.accent}"/>`,
    });
  }
  if (subText && subFs) {
    const subW = subFs * 0.92 * subText.length;
    if (style === 4) {
      // Caption inside an accent pill with reversed (paper) text.
      const padX = 90;
      const pillW = Math.min(CONTENT_W, Math.round(subW) + padX * 2);
      const pillH = subFs + 130;
      blocks.push({
        h: pillH + 120,
        draw: (t) =>
          `<rect x="${CENTER_X - pillW / 2}" y="${t + 60}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${pal.accent}"/>` +
          textEl(subText, CENTER_X, t + 60 + pillH * 0.72, subFs, "#ffffff", subFs * 0.18),
      });
    } else if (style === 3) {
      const ruleW = Math.min(CONTENT_W, Math.max(headlineW, subW + 300));
      blocks.push({
        h: 150,
        draw: (t) =>
          `<rect x="${CENTER_X - ruleW / 2}" y="${t + 40}" width="${ruleW}" height="22" fill="${pal.ink}"/>`,
      });
      blocks.push({
        h: subFs + 90,
        draw: (t) => textEl(subText, CENTER_X, t + subFs * 0.9, subFs, pal.ink, subFs * 0.2),
      });
      blocks.push({
        h: 150,
        draw: (t) =>
          `<rect x="${CENTER_X - ruleW / 2}" y="${t + 60}" width="${ruleW}" height="22" fill="${pal.ink}"/>`,
      });
    } else {
      blocks.push({
        h: subFs + 110,
        draw: (t) => textEl(subText, CENTER_X, t + subFs * 0.9, subFs, pal.ink, subFs * 0.2),
      });
    }
  }

  const total = blocks.reduce((sum, b) => sum + b.h, 0);
  let y = (VIEW - total) / 2;

  const parts: string[] = [];
  for (const b of blocks) {
    parts.push(b.draw(y));
    y += b.h;
  }

  // Frame style wraps the finished stack in a rounded rule.
  if (style === 1) {
    const padX = 150;
    const padY = 120;
    const frameW = Math.min(2240, headlineW + padX * 2);
    const fx = CENTER_X - frameW / 2;
    const fy = (VIEW - total) / 2 - padY;
    const fh = total + padY * 2;
    parts.push(
      `<rect x="${Math.round(fx)}" y="${Math.round(fy)}" width="${Math.round(frameW)}" height="${Math.round(fh)}" rx="60" fill="none" stroke="${pal.ink}" stroke-width="26"/>`
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}"` +
    ` width="${VIEW}" height="${VIEW}" role="img" aria-label="${esc(raw)}">` +
    parts.join("") +
    `</svg>`
  );
}

// ---------- remote seam ----------

/**
 * Loose contract for an external design API, left for when one is wired:
 * POST <IMAGE_GEN_API_URL> with {Authorization: Bearer <IMAGE_GEN_API_KEY>,
 * content-type: application/json} and body {prompt, size: "2400x2400"}.
 * Accepted responses: JSON {imageUrl} | {svg} | {b64} (base64 image), or raw
 * image bytes (content-type image/*). Anything else is an error and the local
 * generator takes over.
 */
async function generateRemote(prompt: string, url: string, apiKey: string): Promise<DesignOutput> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt, size: "2400x2400" }),
  });
  if (!res.ok) throw new Error(`design API returned ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.startsWith("image/")) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { imageUrl: `data:${contentType.split(";")[0]};base64,${buf.toString("base64")}` };
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.svg === "string") return { svg: data.svg };
  if (typeof data.b64 === "string") return { imageUrl: `data:image/png;base64,${data.b64}` };
  if (typeof data.imageUrl === "string") return { imageUrl: data.imageUrl };
  throw new Error("design API returned no recognizable image");
}

/**
 * Prompt in, design out. Remote API when configured, deterministic local SVG
 * otherwise (and as fallback when the remote call fails).
 */
export async function generateDesign(prompt: string): Promise<DesignOutput> {
  const url = process.env.IMAGE_GEN_API_URL;
  const apiKey = process.env.IMAGE_GEN_API_KEY;
  if (url && apiKey) {
    try {
      const out = await generateRemote(prompt, url, apiKey);
      return { ...out, engine: "remote" };
    } catch (err) {
      // Never log the key or URL-embedded credentials — message only.
      console.error("[designgen] remote generator failed, using local SVG:", err instanceof Error ? err.message : err);
    }
  }
  return { svg: renderLocalDesignSvg(prompt), engine: "local" };
}

// ---------- listing copy ----------

/** 2–3 plain sentences describing a generated (text-prompt) design. */
export function describeDesign(prompt: string, engine: DesignEngine): string {
  let p = prompt.trim().replace(/\s+/g, " ");
  if (p.length > 200) {
    const cut = p.slice(0, 200);
    p = (cut.lastIndexOf(" ") > 120 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).trim() + "…";
  }
  const s1 = /[.!?]$/.test(p) ? p : `${p}.`;
  const s2 =
    engine === "local"
      ? "Heavy stacked type with a single accent, drawn to read from across the room."
      : "Artwork was generated for this piece from the original design brief.";
  const s3 = "Printed on demand on soft unisex cotton — grab it as a tee or a hoodie.";
  return `${s1} ${s2} ${s3}`;
}

/** 2–3 plain sentences describing an owner-uploaded artwork. */
export function describeImageDesign(name: string): string {
  return (
    `${name}, printed exactly as supplied. ` +
    "The artwork is reproduced as-is on soft unisex cotton. " +
    "Grab it as a tee or a hoodie."
  );
}

/** Derive a product name from a text prompt (first few words, title case). */
export function defaultDesignName(prompt: string): string {
  const words = prompt
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9'&-]/g, ""))
    .filter(Boolean)
    .slice(0, 3);
  if (!words.length) return "New Drop";
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  return name.slice(0, 40);
}
