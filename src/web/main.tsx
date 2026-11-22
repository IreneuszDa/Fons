import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";

import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import plPL from "@astryxdesign/core/locales/pl-PL.generated.js";
import { Theme } from "@astryxdesign/core/theme";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { defaultThemeSlug, themes } from "../astryx-themes";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Brak elementu #root");

createRoot(rootEl).render(
  <StrictMode>
    <InternationalizationProvider locale="pl-PL" messages={{ "pl-PL": plPL }}>
      <Theme theme={themes[defaultThemeSlug]}>
        <App />
      </Theme>
    </InternationalizationProvider>
  </StrictMode>,
);
