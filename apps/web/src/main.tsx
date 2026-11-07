import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startAnalytics } from "./analytics.ts";
import "./styles.css";

startAnalytics();

const ChipPage = lazy(() => import("./chip/ChipPage.tsx").then((m) => ({ default: m.ChipPage })));
const Community = lazy(() => import("./Community.tsx").then((m) => ({ default: m.Community })));
const communityPage = /^\/(registry|package\/|u\/)/.test(location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname === "/chip" ? (
      <Suspense fallback={null}>
        <ChipPage />
      </Suspense>
    ) : communityPage ? (
      <Suspense fallback={null}>
        <Community />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
