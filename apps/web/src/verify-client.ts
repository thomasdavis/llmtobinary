// Lazily started T3 verifier worker (classic worker; loads the solver only when first used).
import type { VerifyRequest, VerifyResponse } from "./verify.worker.ts";

let worker: Worker | null = null;
let next = 0;
const jobs = new Map<number, (r: VerifyResponse) => void>();

export function verify(bytes: Uint8Array, taskId: string | null, annotations: unknown): Promise<VerifyResponse> {
  if (!worker) {
    worker = new Worker(new URL("./verify.worker.ts", import.meta.url));
    worker.onmessage = (ev: MessageEvent<VerifyResponse>) => {
      jobs.get(ev.data.jobId)?.(ev.data);
      jobs.delete(ev.data.jobId);
    };
  }
  const jobId = ++next;
  const copy = bytes.slice().buffer;
  return new Promise((resolve) => {
    jobs.set(jobId, resolve);
    worker!.postMessage({ jobId, bytes: copy, taskId, annotations } satisfies VerifyRequest, [copy]);
  });
}
