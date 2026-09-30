import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const ChipPage = lazy(() => import("./chip/ChipPage.tsx").then((m) => ({ default: m.ChipPage })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname === "/chip" ? (
      <Suspense fallback={null}>
        <ChipPage />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
