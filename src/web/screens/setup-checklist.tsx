import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import {
  Button,
  Notice,
  PendingState,
  StatusBadge,
} from "../components/index.js";
import { useLocale } from "../locale.js";
import { useNavigation } from "../navigation.js";
import {
  httpConfigurationClient,
  type ConfigurationClient,
  type ConfigurationState,
} from "./settings.js";

export interface SetupChecklistProps {
  readonly configuration?: ConfigurationClient;
}

interface ChecklistItemProps {
  readonly title: string;
  readonly detail: string;
  readonly state: "complete" | "waiting" | "pending";
  readonly action?: string;
  readonly onOpen?: () => void;
}

function ChecklistItem({
  title,
  detail,
  state,
  action,
  onOpen,
}: ChecklistItemProps): ReactElement {
  const { t } = useLocale();
  const complete = state === "complete";
  const waiting = state === "waiting";

  return (
    <section className="mc-panel mc-stack" aria-label={title}>
      <div className="mc-panel__head">
        <div>
          <h2 className="mc-panel__title">{title}</h2>
          <p className="mc-panel__note">{detail}</p>
        </div>
        <StatusBadge
          state={complete ? "active" : waiting ? "attention" : "neutral"}
          dot={complete}
        >
          {t(
            complete
              ? "screens.setupJourney.complete"
              : waiting
                ? "screens.setupJourney.awaitingMeta"
                : "screens.setupJourney.pending",
          )}
        </StatusBadge>
      </div>
      {complete || action === undefined || onOpen === undefined ? null : (
        <div>
          <Button variant="secondary" onClick={onOpen}>
            {action}
          </Button>
        </div>
      )}
    </section>
  );
}

export function SetupChecklistScreen({
  configuration = httpConfigurationClient,
}: SetupChecklistProps = {}): ReactElement {
  const { t } = useLocale();
  const { navigate } = useNavigation();
  const [state, setState] = useState<ConfigurationState>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    void configuration.read().then(
      (next): void => {
        if (current) setState(next);
      },
      (): void => {
        if (current) setFailed(true);
      },
    );
    return (): void => {
      current = false;
    };
  }, [configuration]);

  if (state === undefined && !failed) {
    return <PendingState label={t("screens.setupJourney.loading")} />;
  }

  if (failed || state === undefined) {
    return (
      <Notice nature="error" title={t("screens.setupJourney.errorTitle")}>
        {t("screens.setupJourney.error")}
      </Notice>
    );
  }

  const callbackDetailsReady =
    state.publicOrigin !== undefined && state.webhookVerifyToken;
  const webhookConfirmed = state.webhookConfirmedAt !== undefined;
  const metaConfirmed = state.meta.configured && webhookConfirmed;
  const awaitingMetaConfirmation = callbackDetailsReady && !webhookConfirmed;

  return (
    <div className="mc-page">
      <header className="mc-page-head">
        <div className="mc-page__titles">
          <h1>{t("screens.setupJourney.title")}</h1>
          <p className="mc-page__lead">{t("screens.setupJourney.intro")}</p>
        </div>
      </header>
      <ChecklistItem
        title={t("screens.setupJourney.webhookTitle")}
        detail={t(
          webhookConfirmed
            ? "screens.setupJourney.webhookReady"
            : callbackDetailsReady
              ? "screens.setupJourney.webhookAwaitingMeta"
              : "screens.setupJourney.webhookPending",
        )}
        state={
          webhookConfirmed
            ? "complete"
            : awaitingMetaConfirmation
              ? "waiting"
              : "pending"
        }
        {...(!awaitingMetaConfirmation && !webhookConfirmed
          ? {
              action: t("screens.setupJourney.openIntegrations"),
              onOpen: (): void => navigate("/instance"),
            }
          : {})}
      />
      <ChecklistItem
        title={t("screens.setupJourney.metaTitle")}
        detail={t(
          metaConfirmed
            ? "screens.setupJourney.metaReady"
            : state.meta.configured
              ? "screens.setupJourney.metaAwaitingMeta"
              : "screens.setupJourney.metaPending",
        )}
        state={
          metaConfirmed
            ? "complete"
            : state.meta.configured
              ? "waiting"
              : "pending"
        }
        {...(!state.meta.configured
          ? {
              action: t("screens.setupJourney.openIntegrations"),
              onOpen: (): void => navigate("/instance"),
            }
          : {})}
      />
      <ChecklistItem
        title={t("screens.setupJourney.storageTitle")}
        detail={t("screens.setupJourney.storageOptional")}
        state={state.storage.configured ? "complete" : "pending"}
        action={t("screens.setupJourney.openIntegrations")}
        onOpen={(): void => navigate("/instance")}
      />
    </div>
  );
}
