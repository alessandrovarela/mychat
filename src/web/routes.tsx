import type { ComponentType } from "react";
import { AutomationFormScreen } from "./screens/automation-form.js";
import {
  AutomationsScreen,
  AutomationStartScreen,
} from "./screens/automations.js";
import { DashboardScreen } from "./screens/dashboard.js";
import { LoginScreen } from "./screens/login.js";
import { PublicationsScreen } from "./screens/publications.js";
import { SettingsScreen } from "./screens/settings.js";

/**
 * The route table of the interface: the one place a screen becomes reachable.
 *
 * INTEGRATION POINT. Every screen lives in `src/web/screens/<name>.tsx` and
 * appears here as ONE entry, appended to the array below:
 *
 *     import { FlowsScreen } from "./screens/flows.js";
 *     ...
 *     { path: "/flows", Screen: FlowsScreen },
 *
 * Plain data, and nothing else in this file changes when a screen lands. That
 * is deliberate: several screens are written in parallel, each one adds a line,
 * and appending a line cannot break the screen next to it.
 *
 * The ROOT (`/`) is absent on purpose, and so is any entry standing for "no
 * screen at this address". Neither is a screen: the root is a DIVERSION that
 * depends on whether a session is open, and an address nobody claimed is the
 * same question asked by accident. Both are answered by the doorway of
 * `src/web/App.tsx` (REQ-302). An entry here would have to name a component,
 * and there is none to name.
 */

export interface RouteEntry {
  /** The pathname exactly as the browser shows it, leading slash included. */
  readonly path: string;
  /** Rendered when the pathname matches. */
  readonly Screen: ComponentType;
  /**
   * True for a screen that has to be reachable with NO session open, which is
   * `/login` and only `/login`.
   *
   * Every other entry is a private screen, and the navigation of the shell
   * offers every private screen (REQ-112): an entry appended here without this
   * flag is a screen the rail must lead to, and `src/web/app.test.tsx` checks
   * that it does.
   */
  readonly public?: boolean;
  /**
   * False for a private screen reached FROM another screen and never from the
   * rail: the automation form is one. A detail screen still demands a session,
   * so `public` stays what it is; what this says is only that the navigation
   * does not lead to it, and `src/web/app.test.tsx` reads it to know which
   * routes it must find there.
   */
  readonly rail?: boolean;
  /**
   * The rail destination a DETAIL route belongs to, which is the entry the rail
   * marks while that route is open (REQ-147).
   *
   * Declared here rather than derived from the address, because "the address
   * with its last segment removed" is a guess: it happens to be right for
   * `/automations/form` and would be wrong the day a detail lives somewhere
   * else. A route kept off the rail with no parent leaves the operator with
   * nothing marked, which is exactly the defect this closes, so
   * `src/web/app.test.tsx` demands one from every `rail: false` entry.
   */
  readonly parent?: string;
}

export const routes: readonly RouteEntry[] = [
  { path: "/login", Screen: LoginScreen, public: true },
  { path: "/automations", Screen: AutomationsScreen },
  {
    // Where a new automation begins (REQ-227): the trigger is chosen here, and
    // the editor is opened with it already answered.
    path: "/automations/new",
    Screen: AutomationStartScreen,
    rail: false,
    parent: "/automations",
  },
  {
    path: "/automations/form",
    Screen: AutomationFormScreen,
    rail: false,
    parent: "/automations",
  },
  { path: "/publications", Screen: PublicationsScreen },
  { path: "/dashboard", Screen: DashboardScreen },
  { path: "/settings", Screen: SettingsScreen },
  {
    // Kept as a reachable alias so bookmarks from before Settings grew beyond
    // language do not become a not-found page (REQ-206).
    path: "/settings/language",
    Screen: SettingsScreen,
    rail: false,
    parent: "/settings",
  },
];
