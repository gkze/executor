import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

/** The dashboard's `--background` token in each theme. */
const background = { light: "rgb(255, 255, 255)", dark: "rgb(10, 10, 10)" } as const;

/** What the page shows: its theme override, its used color scheme and its painted background. */
const appearance = (page: Page) =>
  page.evaluate(() => ({
    override: document.documentElement.dataset.theme ?? null,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body).backgroundColor,
  }));

const savedTheme = (page: Page) =>
  page
    .context()
    .cookies()
    .then((cookies) => cookies.find((cookie) => cookie.name === "executor-theme")?.value ?? null);

const choose = (page: Page, theme: "System" | "Light" | "Dark") =>
  page
    .getByRole("complementary")
    .getByRole("button", { name: "Theme", exact: true })
    .click()
    .then(() => page.getByRole("menuitemradio", { name: theme, exact: true }).click());

layer(HostedLive, { excludeTestServices: true })("Theme", (it) => {
  it.effect(scenarios.themeChoice.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        yield* browser.login(actors.owner);
        yield* browser.use("Use a light system appearance", (page) =>
          page.emulateMedia({ colorScheme: "light" }),
        );
        yield* browser.use("Open the dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}`),
        );
        expect(yield* browser.use("System theme is light", appearance)).toEqual({
          override: null,
          scheme: "light dark",
          background: background.light,
        });

        yield* browser.use("Choose the dark theme", (page) => choose(page, "Dark"));
        yield* browser.use("Dark theme applies at once", (page) =>
          expect
            .poll(() => appearance(page))
            .toEqual({
              override: "dark",
              scheme: "dark",
              background: background.dark,
            }),
        );
        expect(yield* browser.use("Dark theme is saved", savedTheme)).toBe("dark");
        yield* browser.checkpoint("Dark theme over a light system appearance");

        // The saved choice is on the root before any stylesheet or script of the page runs, so the
        // first paint already uses it.
        expect(
          yield* browser.use("A new document starts dark", (page) =>
            page
              .reload({ waitUntil: "commit" })
              .then(() => page.waitForSelector("body", { state: "attached" }))
              .then(() => page.evaluate(() => document.documentElement.dataset.theme ?? null)),
          ),
        ).toBe("dark");
        expect(yield* browser.use("Reloaded page is dark", appearance)).toEqual({
          override: "dark",
          scheme: "dark",
          background: background.dark,
        });

        yield* browser.use("Choose the system theme", (page) => choose(page, "System"));
        yield* browser.use("System theme follows the light appearance", (page) =>
          expect
            .poll(() => appearance(page))
            .toEqual({
              override: null,
              scheme: "light dark",
              background: background.light,
            }),
        );
        expect(yield* browser.use("System theme clears the saved choice", savedTheme)).toBe(null);
        yield* browser.use("Change the system appearance to dark", (page) =>
          page.emulateMedia({ colorScheme: "dark" }),
        );
        expect(yield* browser.use("System theme follows the dark appearance", appearance)).toEqual({
          override: null,
          scheme: "light dark",
          background: background.dark,
        });

        yield* browser.use("Choose the light theme", (page) => choose(page, "Light"));
        yield* browser.use("Light theme overrides the dark appearance", (page) =>
          expect
            .poll(() => appearance(page))
            .toEqual({
              override: "light",
              scheme: "light",
              background: background.light,
            }),
        );
        expect(yield* browser.use("Light theme is saved", savedTheme)).toBe("light");
        yield* browser.checkpoint("Light theme over a dark system appearance");
      }),
    ),
  );
});
