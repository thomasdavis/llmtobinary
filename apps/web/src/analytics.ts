// Google Analytics 4 (property 560154524), production only so staging and local development
// stay out of the numbers. Loaded from this bundled module rather than an inline snippet because
// our CSP allows no inline script. gtag.js sends Cross-Origin-Resource-Policy: cross-origin, so
// it loads under our COEP; public/_headers allows its script, beacon, and pixel origins.
// Enhanced measurement records the history changes generation links make as page views.
const MEASUREMENT_ID = "G-3TYRPHYE0J";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function startAnalytics(): void {
  if (location.hostname !== "llmtobinary.com") return;
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag() {
    // gtag.js reads the arguments object itself, not an array.
    window.dataLayer!.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", MEASUREMENT_ID);
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(script);
}
