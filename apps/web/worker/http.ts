// HTTP helpers: bounded JSON bodies, API security headers, origin (CSRF) checks.

export const API_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...extra } });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  const status = (e as { status?: number })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) return json({ error: (e as Error).message }, status);
  console.error("internal error", (e as Error)?.name);
  return json({ error: "internal error" }, 500);
}

export async function readJson<T>(request: Request, maxBytes: number): Promise<T> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new HttpError(413, `request body exceeds ${maxBytes} bytes`);
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "missing request body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) throw new HttpError(413, `request body exceeds ${maxBytes} bytes`);
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

/** POSTs must come from this site's own origin (browsers always send Origin on POST fetches). */
export function checkOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const self = new URL(request.url).origin;
  if (!origin || origin !== self) throw new HttpError(403, "cross-origin or origin-less POST rejected");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") throw new HttpError(403, "cross-site request rejected");
}
