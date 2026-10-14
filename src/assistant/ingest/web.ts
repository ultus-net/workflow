import { SourceBundleSchema, type Lang, type SourceBlock, type SourceBundle } from "../model/source.js";

/**
 * URL and YouTube ingest. YouTube captions are fetched through the public
 * timedtext endpoint, which needs no API key. Page text is extracted with a
 * small HTML-to-text pass. Both degrade gracefully and report what they got.
 */

export interface WebIngestOptions {
  lang: Lang;
  fetchImpl?: typeof fetch;
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

const YT_ID = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

export function youtubeId(url: string): string | null {
  const m = url.match(YT_ID);
  return m ? m[1]! : null;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]!).trim() || undefined : undefined;
}

/** Pull chapter markers, which map cleanly onto H2 sections later. */
function parseChapters(desc: string): SourceBlock[] {
  const out: SourceBlock[] = [];
  const re = /(?:^|\n)\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]?\s*(.+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(desc)) !== null) {
    const parts = m[1]!.split(":").map(Number);
    const secs = parts.length === 3
      ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
      : parts[0]! * 60 + parts[1]!;
    const block: SourceBlock = {
      id: newId("blk"),
      kind: "heading",
      label: m[2]!.trim(),
      start: 0,
      end: 0,
      text: m[2]!.trim(),
      timestamp: secs,
    };
    out.push(block);
  }
  return out;
}

export async function ingestUrl(url: string, opts: WebIngestOptions): Promise<SourceBundle> {
  const doFetch = opts.fetchImpl ?? fetch;
  const yt = youtubeId(url);
  if (yt) return ingestYouTube(yt, url, opts);
  const res = await doFetch(url, { headers: { "user-agent": "augur/0.1" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  const html = await res.text();
  const text = stripTags(html);
  const title = pageTitle(html) ?? url;
  const blocks: SourceBlock[] = [];
  let cursor = 0;
  for (const para of text.split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (trimmed.length < 24) continue;
    const idx = text.indexOf(para, cursor);
    blocks.push({
      id: newId("blk"),
      kind: trimmed.length < 80 && !trimmed.endsWith(".") ? "heading" : "paragraph",
      start: idx,
      end: idx + para.length,
      text: trimmed,
    });
    cursor = idx + para.length;
  }
  return SourceBundleSchema.parse({
    id: newId("src"),
    kind: "url",
    title,
    uri: url,
    lang: opts.lang,
    text,
    blocks,
    attachments: [],
    meta: { url },
  });
}

interface TimedTextEvent {
  tStartMs?: number;
  segs?: Array<{ utf8?: string }>;
  utf8?: string;
}

export async function ingestYouTube(
  videoId: string,
  url: string,
  opts: WebIngestOptions,
): Promise<SourceBundle> {
  const doFetch = opts.fetchImpl ?? fetch;
  const watch = `https://www.youtube.com/watch?v=${videoId}`;
  const page = await doFetch(watch, { headers: { "user-agent": "augur/0.1" } });
  const html = await page.text();
  const title = pageTitle(html)?.replace(/\s*-\s*YouTube\s*$/i, "") ?? `YouTube ${videoId}`;

  const playerMatch = html.match(/"captionTracks":(\[.*?\])/);
  const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);

  let text = "";
  const blocks: SourceBlock[] = [];

  if (playerMatch) {
    const tracks = JSON.parse(playerMatch[1]!) as Array<{ baseUrl: string; languageCode?: string }>;
    const track =
      tracks.find((t) => t.languageCode?.startsWith(opts.lang === "zh-Hans" ? "zh" : "en")) ??
      tracks[0];
    if (track?.baseUrl) {
      const cap = await doFetch(`${track.baseUrl}&fmt=json3`);
      if (cap.ok) {
        const data = (await cap.json()) as { events?: TimedTextEvent[] };
        const events = data.events ?? [];
        const lines: string[] = [];
        for (const ev of events) {
          const line = ev.segs?.map((s) => s.utf8 ?? "").join("") ?? ev.utf8 ?? "";
          if (!line.trim()) continue;
          lines.push(line.trim());
        }
        text = lines.join("\n");
        let cursor = 0;
        for (const ev of events) {
          const line = ev.segs?.map((s) => s.utf8 ?? "").join("") ?? ev.utf8 ?? "";
          const trimmed = line.replace(/\n/g, " ").trim();
          if (trimmed.length < 24) continue;
          const idx = text.indexOf(trimmed, cursor);
          if (idx < 0) continue;
          blocks.push({
            id: newId("blk"),
            kind: "transcript",
            start: idx,
            end: idx + trimmed.length,
            text: trimmed,
            timestamp: (ev.tStartMs ?? 0) / 1000,
          });
          cursor = idx + trimmed.length;
        }
      }
    }
  }

  if (descMatch) {
    const desc = JSON.parse(`"${descMatch[1]!}"`) as string;
    blocks.push(...parseChapters(desc));
    if (!text) text = desc;
  }

  return SourceBundleSchema.parse({
    id: newId("src"),
    kind: "youtube",
    title,
    uri: url,
    lang: opts.lang,
    text,
    blocks,
    attachments: [],
    meta: { videoId },
  });
}
