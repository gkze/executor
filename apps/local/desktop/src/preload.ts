/**
 * The window's preload under an inset title bar (macOS). It runs in an isolated world before each
 * document's own scripts and exposes nothing to the page. On a dashboard page it publishes the
 * window controls' geometry and marks the root with `data-desktop-titlebar` before the first paint,
 * so the server-rendered page is laid out around the controls from its first frame, and it clears
 * the mark while full screen hides the controls.
 */
import { ipcRenderer, webFrame } from "electron";
import { titlebarChannel, type Titlebar } from "./contracts/titlebar.ts";

/**
 * `DashboardShell` lays itself out around the controls. Pages outside it, such as pairing,
 * account connection and MCP consent, start below them instead, and the band above them drags the
 * window. Those pages fill the window with `min-h-dvh`, so they lose the band's height to it rather
 * than scroll by it.
 */
const outsideShell = `
:root[data-desktop-titlebar]:not(:has(.shell)) body { padding-top: var(--desktop-controls-bottom); }
:root[data-desktop-titlebar]:not(:has(.shell)) body::before {
  content: ""; position: fixed; top: 0; left: 0; right: 0;
  height: var(--desktop-controls-bottom); -webkit-app-region: drag;
}
:root[data-desktop-titlebar]:not(:has(.shell)) .min-h-dvh {
  min-height: calc(100dvh - var(--desktop-controls-bottom));
}`;

/** The document's root element, as soon as the parser creates it. */
const withRoot = (use: (root: HTMLElement) => void) => {
  if (document.documentElement !== null) return use(document.documentElement);
  // Mutation records are delivered before the browser next renders, so this precedes first paint.
  const observer = new MutationObserver(() => {
    if (document.documentElement === null) return;
    observer.disconnect();
    use(document.documentElement);
  });
  observer.observe(document, { childList: true });
};

// The status and recovery pages are data: documents that carry their own styles.
if (location.protocol === "http:") {
  const answer: Titlebar | false = ipcRenderer.sendSync(titlebarChannel, location.origin);
  if (answer !== false) {
    const declarations = Object.entries(answer.properties)
      .map(([name, value]) => `${name}: ${value};`)
      .join(" ");
    webFrame.insertCSS(`:root[data-desktop-titlebar] { ${declarations} }${outsideShell}`);
    // Listen before the root exists, so a full-screen change in between is not lost.
    let shown = answer.shown;
    let mark = (_root: HTMLElement) => {};
    ipcRenderer.on(titlebarChannel, (_event, next: boolean) => {
      shown = next;
      if (document.documentElement !== null) mark(document.documentElement);
    });
    withRoot((root) => {
      mark = (element) => element.toggleAttribute("data-desktop-titlebar", shown);
      mark(root);
    });
  }
}
