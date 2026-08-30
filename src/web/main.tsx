import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { LocaleProvider } from "./locale.js";
// The design system, imported once for the whole application (REQ-110,
// REQ-111). Screens and components reference the variables it declares and
// never import CSS themselves, so the cascade is decided in `styles/app.css`
// and not by module evaluation order. `vite build` inlines the chain of
// `@import`s into one stylesheet and links it from `index.html`.
import "./styles/app.css";

/**
 * The browser entry point, and the only file that touches the document.
 *
 * It is loaded by `index.html`, bundled by `vite build`, and served as a plain
 * file by the same process that answers the webhook (REQ-105). No development
 * server is involved in a running installation.
 */

/** The element `index.html` declares, and the only mount point that exists. */
const ROOT_ELEMENT_ID = "root";

const container = document.getElementById(ROOT_ELEMENT_ID);

// A missing container means this bundle was loaded from a page that is not
// ours, so there is nothing to mount into and nothing to report to an operator
// who is not looking at our interface.
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      {/* Around the whole application, and only here: the language of the
          instance is asked for once per load, and every screen below reads it
          from the context instead of fetching it again. */}
      <LocaleProvider>
        <App />
      </LocaleProvider>
    </StrictMode>,
  );
}
