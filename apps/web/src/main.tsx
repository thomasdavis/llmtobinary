import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startAnalytics } from "./analytics.ts";
import "./styles.css";

startAnalytics();

const ChipPage = lazy(() => import("./chip/ChipPage.tsx").then((m) => ({ default: m.ChipPage })));
const Community = lazy(() => import("./Community.tsx").then((m) => ({ default: m.Community })));
const Boot = lazy(() => import("./Boot.tsx").then((m) => ({ default: m.Boot })));
const communityPage = /^\/(registry|os$|package\/|u\/)/.test(location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname === "/chip" ? (
      <Suspense fallback={null}>
        <ChipPage />
      </Suspense>
    ) : location.pathname === "/boot" ? (
      <Suspense fallback={null}>
        <Boot />
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
