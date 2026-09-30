// Signed, expiring, owner-scoped session tokens (HMAC-SHA256). A token proves the bearer created
// the session; it is not by itself an abuse defense (see admission + ledger).

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface TokenClaims {
  sid: string;
  exp: number;
}

export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifyToken(token: string, secret: string, now: number): Promise<TokenClaims | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig || token.length > 2048) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await key(secret), fromB64url(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as TokenClaims;
    if (typeof claims.sid !== "string" || typeof claims.exp !== "number" || claims.exp < now) return null;
    return claims;
  } catch {
    return null;
  }
}
