// Synchronous pure-TypeScript SHA-256 (FIPS 180-4). Engines produce effect and framebuffer
// hashes synchronously inside their step loops, so WebCrypto's async digest cannot be used there.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Uint32Array(64);

  update(data: Uint8Array): this {
    let i = 0;
    this.total += data.length;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen === 64) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = data.length - i;
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.total * 8;
    const pad = new Uint8Array(((this.bufLen < 56 ? 56 : 120) - this.bufLen) + 8);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    const n = pad.length;
    pad[n - 8] = (hi >>> 24) & 255;
    pad[n - 7] = (hi >>> 16) & 255;
    pad[n - 6] = (hi >>> 8) & 255;
    pad[n - 5] = hi & 255;
    pad[n - 4] = (lo >>> 24) & 255;
    pad[n - 3] = (lo >>> 16) & 255;
    pad[n - 2] = (lo >>> 8) & 255;
    pad[n - 1] = lo & 255;
    const saved = this.total;
    this.update(pad);
    this.total = saved;
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = this.h[i]! >>> 24;
      out[i * 4 + 1] = (this.h[i]! >>> 16) & 255;
      out[i * 4 + 2] = (this.h[i]! >>> 8) & 255;
      out[i * 4 + 3] = this.h[i]! & 255;
    }
    return out;
  }

  private block(d: Uint8Array, o: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = (d[o + i * 4]! << 24) | (d[o + i * 4 + 1]! << 16) | (d[o + i * 4 + 2]! << 8) | d[o + i * 4 + 3]!;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, dd, e, f, g, h] = [this.h[0]!, this.h[1]!, this.h[2]!, this.h[3]!, this.h[4]!, this.h[5]!, this.h[6]!, this.h[7]!];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (dd + t1) | 0;
      dd = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    this.h[0] = (this.h[0]! + a) | 0;
    this.h[1] = (this.h[1]! + b) | 0;
    this.h[2] = (this.h[2]! + c) | 0;
    this.h[3] = (this.h[3]! + dd) | 0;
    this.h[4] = (this.h[4]! + e) | 0;
    this.h[5] = (this.h[5]! + f) | 0;
    this.h[6] = (this.h[6]! + g) | 0;
    this.h[7] = (this.h[7]! + h) | 0;
  }
}

export function sha256HexSync(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = new Sha256().update(bytes).digest();
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}
