// Search and link previews for a single-page app: crawlers do not run JavaScript, so a shared
// /?program=<id> link gets that generation's own title, description and canonical URL written into
// the HTML here, and /sitemap.xml lists the home page and every generation that works.

import { isGalleryId, listGallery } from "./gallery.ts";

const SITE_TITLE = "llmtobinary";

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?…-]+$/, "")}…`;
}

export interface ProgramMeta {
  label: string;
  prompt: string;
  outcome: string;
}

/** The head of the page for one generation. */
export function programHead(meta: ProgramMeta, url: string): { title: string; description: string; url: string } {
  const works = meta.outcome === "passed" || meta.outcome === "passed-unverified";
  const what = works ? "An AI wrote this program as raw machine code, byte by byte, with no compiler. Run it in your browser." : "An AI tried to write this program as raw machine code, byte by byte. See how far it got.";
  return {
    title: `${shorten(meta.label || "A program", 70)} · ${SITE_TITLE}`,
    description: `“${shorten(meta.prompt, 150)}” ${what}`,
    url,
  };
}

/** Write a generation's title, description and canonical URL into the app's HTML. */
export function rewriteHead(res: Response, head: { title: string; description: string; url: string }): Response {
  // The rewriter escapes '"' in attribute values; '&' is ours to escape so text never forms a
  // character reference. ('<' and '>' are inert inside a quoted attribute.)
  const attr = (v: string) => v.replace(/&/g, "&amp;");
  const content = (value: string) => ({ element: (e: Element) => void e.setAttribute("content", attr(value)) });
  const out = new HTMLRewriter()
    .on("title", { element: (e) => void e.setInnerContent(head.title) })
    .on('meta[name="description"]', content(head.description))
    .on('meta[property="og:title"]', content(head.title))
    .on('meta[property="og:description"]', content(head.description))
    .on('meta[property="og:url"]', content(head.url))
    .on('meta[name="twitter:title"]', content(head.title))
    .on('meta[name="twitter:description"]', content(head.description))
    .on('link[rel="canonical"]', { element: (e) => void e.setAttribute("href", attr(head.url)) })
    .transform(res);
  // The body now differs per program: drop validators that describe the static file.
  const headers = new Headers(out.headers);
  headers.delete("etag");
  headers.delete("content-length");
  return new Response(out.body, { status: out.status, headers });
}

/** The app page, with a generation's own metadata when the link names one. */
export async function programPage(request: Request, env: Env, siteOrigin: string): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  const id = new URL(request.url).searchParams.get("program");
  if (!id || !isGalleryId(id) || !env.DEBUG_ARCHIVE || res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  const obj = await env.DEBUG_ARCHIVE.head(`gallery/${id}.json`);
  const m = obj?.customMetadata;
  if (!m) return res;
  return rewriteHead(res, programHead({ label: m.label ?? "", prompt: m.prompt ?? "", outcome: m.outcome ?? "" }, `${siteOrigin}/?program=${id}`));
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Home plus every generation that works, newest first (bounded). */
export async function sitemap(env: Env, siteOrigin: string): Promise<Response> {
  const urls: { loc: string; lastmod?: string }[] = [{ loc: `${siteOrigin}/` }];
  if (env.DEBUG_ARCHIVE) {
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = await listGallery(env.DEBUG_ARCHIVE, cursor, 1000);
      for (const g of r.items) {
        if (g.outcome !== "passed" && g.outcome !== "passed-unverified") continue;
        urls.push({ loc: `${siteOrigin}/?program=${g.id}`, lastmod: new Date(g.finishedAt ?? g.updatedAt).toISOString() });
      }
      if (!r.cursor) break;
      cursor = r.cursor;
    }
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${xml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
}
