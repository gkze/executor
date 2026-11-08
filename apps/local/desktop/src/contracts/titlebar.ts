/**
 * How the main process tells dashboard pages about the inset title bar (macOS) through the
 * window's preload (see `preload.ts`). A page asks once with its origin, synchronously, before its
 * first paint; the main process answers `false` when the page is not the dashboard, else the
 * window controls' geometry and whether they show over the page. When the window enters or leaves
 * full screen, where macOS hides the controls, it sends the page whether they show.
 */
export const titlebarChannel = "executor-desktop:titlebar";

export interface Titlebar {
  /** The controls' geometry as CSS custom properties, applied while the page is marked. */
  readonly properties: Readonly<Record<string, string>>;
  readonly shown: boolean;
}
