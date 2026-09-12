import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en.json";
import { LocaleProvider } from "../locale.js";
import { NavigationProvider } from "../navigation.js";
import { SetupChecklistScreen } from "./setup-checklist.js";
import type { ConfigurationClient, ConfigurationState } from "./settings.js";

const pending: ConfigurationState = {
  meta: { configured: false, appSecretConfigured: false },
  storage: { driver: "local", configured: true },
  installedVersion: "0.0.0",
  webhookVerifyToken: false,
};

function configuration(state: ConfigurationState): ConfigurationClient {
  return {
    read: (): Promise<ConfigurationState> => Promise.resolve(state),
    write: (): never => {
      throw new Error("the checklist does not write configuration");
    },
  };
}

describe("REQ-442: setup checklist", () => {
  it("places webhook before Meta and keeps storage optional", async () => {
    const { container } = render(
      <LocaleProvider>
        <NavigationProvider pathname="/setup">
          <SetupChecklistScreen configuration={configuration(pending)} />
        </NavigationProvider>
      </LocaleProvider>,
    );

    expect(
      await screen.findByRole("heading", {
        name: en.screens.setupJourney.title,
      }),
    ).toBeInTheDocument();
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((item) => item.textContent);
    expect(headings).toEqual([
      en.screens.setupJourney.webhookTitle,
      en.screens.setupJourney.metaTitle,
      en.screens.setupJourney.storageTitle,
    ]);
    expect(
      screen.getByText(en.screens.setupJourney.storageOptional),
    ).toBeInTheDocument();
    expect(container.querySelector(".mc-page")).not.toBeNull();
  });

  it("marks completed steps with the shared green status badge", async () => {
    render(
      <LocaleProvider>
        <NavigationProvider pathname="/setup">
          <SetupChecklistScreen
            configuration={configuration({
              ...pending,
              publicOrigin: "https://mychat.example.test",
              webhookVerifyToken: true,
              webhookConfirmedAt: "2026-09-06T00:00:00.000Z",
            })}
          />
        </NavigationProvider>
      </LocaleProvider>,
    );

    const completed = await screen.findAllByText(
      en.screens.setupJourney.complete,
    );

    expect(completed).not.toHaveLength(0);
    expect(
      completed.every((item) => item.classList.contains("mc-badge--active")),
    ).toBe(true);
  });

  it("marks the webhook as waiting when Meta has not confirmed it", async () => {
    render(
      <LocaleProvider>
        <NavigationProvider pathname="/setup">
          <SetupChecklistScreen
            configuration={configuration({
              ...pending,
              publicOrigin: "https://mychat.example.test",
              webhookVerifyToken: true,
            })}
          />
        </NavigationProvider>
      </LocaleProvider>,
    );

    expect(
      await screen.findByText(en.screens.setupJourney.webhookAwaitingMeta),
    ).toBeInTheDocument();
    expect(screen.getByText(en.screens.setupJourney.awaitingMeta)).toHaveClass(
      "mc-badge--attention",
    );
  });

  it("does not ask for action again when configuration only awaits Meta", async () => {
    render(
      <LocaleProvider>
        <NavigationProvider pathname="/setup">
          <SetupChecklistScreen
            configuration={configuration({
              ...pending,
              meta: {
                configured: true,
                appSecretConfigured: true,
                accountId: "17841465699776281",
              },
              publicOrigin: "https://mychat.example.test",
              publicOriginVerifiedAt: "2026-09-06T00:00:00.000Z",
              webhookVerifyToken: true,
            })}
          />
        </NavigationProvider>
      </LocaleProvider>,
    );

    expect(
      await screen.findByText(en.screens.setupJourney.metaAwaitingMeta),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(en.screens.setupJourney.awaitingMeta),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("button", {
        name: en.screens.setupJourney.openIntegrations,
      }),
    ).not.toBeInTheDocument();
  });
});
