import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import {
  Button,
  ButtonLink,
  EmptyState,
  Field,
  Icon,
  ICON_SIZE,
  Notice,
  Pagination,
  PendingState,
  PublicationGrid,
  StatusBadge,
} from "../components/index.js";
import type { PublicationItem } from "../components/index.js";
import { isUnauthorizedFailure } from "../http-failure.js";
import { useLocale } from "../locale.js";
import { useNavigation } from "../navigation.js";
import { SessionExpiredNotice } from "../session-expired.js";

/**
 * The publication grid the operator picks a target from (REQ-069, REQ-072).
 *
 * The whole point of this screen is to stop an operator pasting an identifier
 * they had to go and find. The whole point of REQ-072 is that they still CAN:
 * the grid is a convenience over a cache that may be empty, stale or
 * unreachable, and none of that is allowed to stand between the operator and an
 * automation. So the picker never renders a dead end, and REQ-115 is that
 * promise made visible: the five things it can be showing look like five
 * different things.
 *
 *   - READING. A pending state with the sentence and placeholder rows, so the
 *     shape of what is coming is already on screen.
 *   - EMPTY. An empty state, not an error: a fresh installation has stored
 *     nothing yet, and the one action that ends it sits inside the block.
 *   - UNAVAILABLE. The request itself failed (the process is down, the session
 *     expired). An `error` notice, whatever was already on screen stays, and
 *     the notice names the remedy rather than only the fault.
 *   - DEGRADED. The request answered with `failure` beside the items: the
 *     platform was consulted and refused, so the rows are the cache's and the
 *     platform's own answer is quoted. A `warning`, because there is something
 *     usable on screen, which is exactly what an `error` would deny.
 *   - A BROKEN THUMBNAIL. The platform's image address expires and can answer
 *     404, and the publication behind it is still a perfectly good target. The
 *     tile falls back to a labelled placeholder and stays selectable, which is
 *     `PublicationGrid`'s own behaviour and the reason `brokenLabel` is
 *     required by its type.
 *
 * What changed from the grid this phase replaces: the thumbnail dominates, the
 * media type is a small overlay, the date is discreet and the platform's
 * 17 digit identifier is present but last, because it means nothing to the
 * person operating (REQ-113). The caption leads the text of each tile for the
 * same reason (REQ-216): a card that read `IMAGE · 09 jun · 17900000000000001`
 * made ten publications ten identical rectangles.
 *
 * In every one of those states, the identifier field beside the grid keeps
 * working. That field is deliberately NOT inside the picker: the automation
 * form owns its own target field and fills it from `onSelect`, so there is one
 * field per screen and the grid is what feeds it.
 */

const PUBLICATIONS_ENDPOINT = "/api/publications";
const REFRESH_ENDPOINT = "/api/publications/refresh";
const LOOKUP_ENDPOINT = "/api/publications/by-id";
const AUTOMATION_COVERAGE_ENDPOINT = "/api/publications/automation-coverage";
const AUTOMATION_FORM_ADDRESS = "/automations/form";
export const PUBLICATION_TARGET_PARAMETER = "target";

/** One publication as the contract answers with it, instants as ISO strings. */
export interface PublicationRow {
  readonly id: string;
  /**
   * The caption, whole (REQ-216). Optional in the contract and optional here:
   * a publication without one is ordinary, and so is a row cached before the
   * caption was ever asked for.
   */
  readonly caption?: string;
  readonly mediaType: string;
  readonly publishedAt: string;
  /** Our address, never the platform's (REQ-071). Absent when no copy exists. */
  readonly thumbnailUrl?: string;
}

export interface PublicationListing {
  readonly items: readonly PublicationRow[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly source: "cache" | "platform";
  readonly cachedAt?: string;
  /** The platform's own answer, quoted when it could not be consulted. */
  readonly failure?: string;
}

export interface PublicationPage {
  readonly limit?: number;
  readonly offset?: number;
}

/** The two calls this screen makes, so a test drives them with a double. */
export interface PublicationsClient {
  open(page?: PublicationPage): Promise<PublicationListing>;
  refresh(page?: PublicationPage): Promise<PublicationListing>;
}

/** What a lookup by identifier answers with. No page: nothing here is paged. */
export interface PublicationLookup {
  readonly items: readonly PublicationRow[];
  /** The platform's own answer, quoted when it could not be consulted. */
  readonly failure?: string;
}

/**
 * Publications named by IDENTIFIER (REQ-144).
 *
 * Its own interface, deliberately narrower than `PublicationsClient`: a screen
 * that wants the thumbnail of targets it already holds the identifiers of has
 * no business being able to page or renew the whole grid, and reading a page to
 * match against is exactly the defect this replaces. A target published before
 * the first page of the grid used to find nothing there and render the marker
 * of an absent thumbnail, which on an account with any history reads as most of
 * the pictures having disappeared.
 */
export interface PublicationFinder {
  byIds(ids: readonly string[]): Promise<PublicationLookup>;
}

export interface PublicationAutomationReference {
  readonly id: string;
  readonly enabled: boolean;
}

export interface PublicationAutomationCoverage {
  readonly publicationId: string;
  readonly active: number;
  readonly inactive: number;
  readonly automations: readonly PublicationAutomationReference[];
}

export interface PublicationAutomationCoverageClient {
  byIds(
    ids: readonly string[],
  ): Promise<readonly PublicationAutomationCoverage[]>;
}

async function readListing(response: Response): Promise<PublicationListing> {
  if (!response.ok) {
    throw new Error(String(response.status));
  }

  return ((await response.json()) as { listing: PublicationListing }).listing;
}

function pageQuery(page: PublicationPage): string {
  const parameters = new URLSearchParams();

  if (page.limit !== undefined) {
    parameters.set("limit", String(page.limit));
  }
  if (page.offset !== undefined) {
    parameters.set("offset", String(page.offset));
  }

  const query = parameters.toString();
  return query === "" ? "" : `?${query}`;
}

/** The real client: same origin, so the session cookie travels on its own. */
export const httpPublicationsClient: PublicationsClient = {
  open: async (page = {}): Promise<PublicationListing> =>
    readListing(await fetch(`${PUBLICATIONS_ENDPOINT}${pageQuery(page)}`)),

  // A POST and not a GET with a flag: this one spends the platform's request
  // budget, and a browser or a proxy is free to repeat a GET (REQ-070).
  refresh: async (page = {}): Promise<PublicationListing> =>
    readListing(
      await fetch(REFRESH_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(page),
      }),
    ),
};

/**
 * The real finder: same origin, so the session cookie travels on its own.
 *
 * The identifiers are repeated parameters (`?ids=a&ids=b`) because that is the
 * shape the route declares as an array. Joining them with a separator would put
 * the parsing back in code on both ends.
 */
export const httpPublicationFinder: PublicationFinder = {
  byIds: async (ids: readonly string[]): Promise<PublicationLookup> => {
    if (ids.length === 0) {
      // No request at all rather than one that asks for nothing: a listing
      // whose automations all watch the whole account names no publication,
      // and that is the ordinary state of a fresh installation.
      return { items: [] };
    }

    const parameters = new URLSearchParams();
    for (const id of ids) {
      parameters.append("ids", id);
    }

    const response = await fetch(`${LOOKUP_ENDPOINT}?${parameters.toString()}`);

    if (!response.ok) {
      throw new Error(String(response.status));
    }

    return ((await response.json()) as { publications: PublicationLookup })
      .publications;
  },
};

export const httpPublicationAutomationCoverageClient: PublicationAutomationCoverageClient =
  {
    byIds: async (
      ids: readonly string[],
    ): Promise<readonly PublicationAutomationCoverage[]> => {
      if (ids.length === 0) {
        return [];
      }

      const parameters = new URLSearchParams();
      for (const id of ids) {
        parameters.append("ids", id);
      }

      const response = await fetch(
        `${AUTOMATION_COVERAGE_ENDPOINT}?${parameters.toString()}`,
      );

      if (!response.ok) {
        throw new Error(String(response.status));
      }

      return (
        (await response.json()) as {
          coverage: readonly PublicationAutomationCoverage[];
        }
      ).coverage;
    },
  };

/** What the grid is doing right now. `failed` means the request itself did. */
type Phase = "loading" | "ready" | "failed" | "unauthorized";

/** Placeholder rows drawn while the listing is read. Two rows of tiles. */
const SKELETON_ROWS = 2;

export interface PublicationPickerProps {
  /** Injected by tests. The running interface talks to `/api/publications`. */
  readonly client?: PublicationsClient;
  /**
   * Handed the publication's identifier, which is what becomes the target, and
   * the ROW behind it when the grid still holds it.
   *
   * The row travels because the identifier alone is seventeen digits: what the
   * screens call an automation is composed from the publication's caption, or
   * from the day when it carries none (REQ-278), and neither can be recovered
   * from the id.
   */
  readonly onSelect: (identifier: string, publication?: PublicationRow) => void;
  /** Marks the tile already chosen, so the grid says which one it was. */
  readonly selectedId?: string;
  /** Present only on the publications screen, where coverage belongs. */
  readonly coverageClient?: PublicationAutomationCoverageClient;
  /** The editor excludes publications that already have a specific automation. */
  readonly excludeAutomated?: boolean;
}

/**
 * A stored instant as the operator's locale writes it.
 *
 * Exported because the same date is what names an automation whose publication
 * carries no caption, on the listing and in the editor alike, and two
 * formatters would drift into two different dates for one publication.
 */
export function formatDate(published: string, locale: string): string {
  const date = new Date(published);

  // An unreadable instant is shown as it arrived rather than as "Invalid Date":
  // the row is still a perfectly good target, and its id is what matters.
  return Number.isNaN(date.getTime())
    ? published
    : date.toLocaleDateString(locale);
}

/**
 * The grid proper (REQ-069): thumbnail, type, date and identifier, paginated,
 * with the explicit refresh REQ-070 asks for.
 *
 * The refresh button lives in this block and not in the page heading, which is
 * the one deliberate departure from the prototype's arrangement: the picker
 * appears in two places (this screen and the automation form's target picker,
 * REQ-113), and a block that could not renew itself would be renewable in one
 * of them only.
 */
export function PublicationPicker({
  client = httpPublicationsClient,
  onSelect,
  selectedId,
  coverageClient,
  excludeAutomated = false,
}: PublicationPickerProps): ReactElement {
  const { t, locale } = useLocale();
  const { follow } = useNavigation();
  const [listing, setListing] = useState<PublicationListing | undefined>(
    undefined,
  );
  const [phase, setPhase] = useState<Phase>("loading");
  const [offset, setOffset] = useState(0);
  const [coverage, setCoverage] = useState<
    readonly PublicationAutomationCoverage[]
  >([]);
  const [coveragePhase, setCoveragePhase] = useState<
    "idle" | "loading" | "ready" | "failed" | "unauthorized"
  >("idle");
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return (): void => {
      live.current = false;
    };
  }, []);

  const load = useCallback(
    async (read: () => Promise<PublicationListing>): Promise<void> => {
      setPhase("loading");

      try {
        const answer = await read();
        if (live.current) {
          setListing(answer);
          setPhase("ready");
        }
      } catch (failure) {
        // The rows already on screen are LEFT there: a request that failed says
        // nothing about publications the operator could select a second ago.
        if (live.current) {
          setPhase(isUnauthorizedFailure(failure) ? "unauthorized" : "failed");
        }
      }
    },
    [],
  );

  useEffect(() => {
    // An opening reads the cache and spends no request budget (REQ-070). The
    // client is a stable module constant by default, so this runs once per page
    // rather than on every render.
    void load(() => client.open({ offset }));
  }, [client, load, offset]);

  const renew = useCallback((): void => {
    void load(() => client.refresh({ offset }));
  }, [client, load, offset]);

  const items = listing?.items ?? [];
  const limit = listing?.limit ?? 0;
  const total = listing?.total ?? 0;
  const shown = listing?.offset ?? offset;
  const fromPlatform = listing?.source === "platform";

  const tiles: readonly PublicationItem[] = items.map((item) => ({
    id: item.id,
    // Handed over whole. What the tile does with a long one is the tile's own
    // decision, and it is a decision about drawing rather than about data.
    caption: item.caption,
    mediaType: item.mediaType,
    // Formatted here rather than in the component: the order of the parts and
    // the separators belong to the locale, and a component knows no language.
    publishedLabel: formatDate(item.publishedAt, locale),
    thumbnailUrl: item.thumbnailUrl,
  }));

  const offeredTiles =
    excludeAutomated && coveragePhase === "ready"
      ? tiles.filter(
          (item) =>
            item.id === selectedId ||
            (coverage.find((entry) => entry.publicationId === item.id)
              ?.automations.length ?? 0) === 0,
        )
      : tiles;

  useEffect(() => {
    if (coverageClient === undefined || items.length === 0) {
      setCoverage((current) => (current.length === 0 ? current : []));
      setCoveragePhase("idle");
      return;
    }

    let current = true;
    setCoverage([]);
    setCoveragePhase("loading");

    void coverageClient
      .byIds(items.map((item) => item.id))
      .then((answer) => {
        if (current && live.current) {
          setCoverage(answer);
          setCoveragePhase("ready");
        }
      })
      .catch((failure: unknown) => {
        if (current && live.current) {
          setCoveragePhase(
            isUnauthorizedFailure(failure) ? "unauthorized" : "failed",
          );
        }
      });

    return (): void => {
      current = false;
    };
  }, [coverageClient, items]);

  const refreshButton = (
    <Button variant="secondary" icon="refresh-cw" onClick={renew}>
      {t("screens.publications.refresh")}
    </Button>
  );

  return (
    <section className="mc-stack">
      {phase === "failed" ? (
        // REQ-072 said out loud: the grid is unavailable and the identifier can
        // still be typed. The notice names the remedy instead of only the fault
        // and carries the one action that could end it.
        <Notice
          nature="error"
          title={t("screens.publications.unavailableTitle")}
          actions={refreshButton}
        >
          {t("screens.publications.unavailable")}
        </Notice>
      ) : null}

      {phase === "unauthorized" ? <SessionExpiredNotice /> : null}

      {phase !== "unauthorized" && coveragePhase === "unauthorized" ? (
        <SessionExpiredNotice />
      ) : null}

      {coveragePhase === "failed" ? (
        <Notice nature="warning">
          {t("screens.publications.coverageUnavailable")}
        </Notice>
      ) : null}

      {listing?.failure === undefined ? null : (
        // A warning and not an error: the platform refused, and what is on
        // screen came from this instance's own store and is still selectable.
        <Notice
          nature="warning"
          title={t("screens.publications.degradedTitle")}
        >
          {t("screens.publications.degraded", { failure: listing.failure })}
        </Notice>
      )}

      <div className="mc-panel">
        <div className="mc-panel__head">
          <span className="mc-panel__title">
            {t("screens.publications.gridTitle")}
          </span>

          <div className="mc-row">
            {listing === undefined ? null : (
              <span className="mc-source">
                {/* The glyph separates the two origins at a glance, and the
                    sentence beside it says the same thing in words: a shape is
                    never the only carrier of a fact in this interface. */}
                <Icon
                  name={fromPlatform ? "refresh-cw" : "database"}
                  size={ICON_SIZE.chip}
                />
                <span>
                  {fromPlatform
                    ? t("screens.publications.sourcePlatform")
                    : t("screens.publications.sourceCache")}
                </span>
                {/* Its own element rather than appended to the one above: two
                    texts joined in JSX have no separator between them, and a
                    locale should not have to carry a leading space for that. */}
                {listing.cachedAt === undefined ? null : (
                  <span>
                    {t("screens.publications.cachedAt", {
                      at: formatDate(listing.cachedAt, locale),
                    })}
                  </span>
                )}
              </span>
            )}
            {phase === "unauthorized" ? null : refreshButton}
          </div>
        </div>

        {phase === "loading" ? (
          <PendingState
            label={t("screens.publications.loading")}
            skeleton={SKELETON_ROWS}
          />
        ) : null}

        {phase !== "loading" &&
        phase !== "unauthorized" &&
        listing !== undefined &&
        items.length === 0 ? (
          <EmptyState
            icon="image"
            title={t("screens.publications.emptyTitle")}
            action={refreshButton}
          >
            {t("screens.publications.empty")}
          </EmptyState>
        ) : null}

        {phase !== "loading" && phase !== "unauthorized" && items.length > 0 ? (
          <>
            <PublicationGrid
              items={offeredTiles}
              selectedId={selectedId}
              onSelect={(id): void => {
                // The row is looked up here rather than carried by the tile:
                // the component knows tiles, and what a caller needs back is
                // the publication this screen read from the instance.
                onSelect(
                  id,
                  items.find((row) => row.id === id),
                );
              }}
              selectLabel={(id): string =>
                t("screens.publications.selectLabel", { id })
              }
              thumbnailAlt={(id): string =>
                t("screens.publications.thumbnailAlt", { id })
              }
              brokenLabel={t("screens.publications.thumbnailBroken")}
              renderDetails={
                coverageClient === undefined
                  ? undefined
                  : (item): ReactElement => {
                      const itemCoverage = coverage.find(
                        (entry) => entry.publicationId === item.id,
                      );
                      const createAddress = `${AUTOMATION_FORM_ADDRESS}?${PUBLICATION_TARGET_PARAMETER}=${encodeURIComponent(item.id)}`;

                      return (
                        <div className="mc-pubtile__coverage">
                          {coveragePhase === "loading" ? (
                            <span>
                              {t("screens.publications.coverageLoading")}
                            </span>
                          ) : null}

                          {coveragePhase === "ready" &&
                          itemCoverage !== undefined ? (
                            <>
                              {/* The state of the automation, as a marker on
                                  the publication itself: what the operator
                                  scans this grid for is which posts are
                                  already working, and a sentence in a
                                  paragraph is read one tile at a time. The
                                  word is inside the marker, never the colour
                                  alone (restriction 4.2). */}
                              <StatusBadge
                                className="mc-pubtile__state"
                                state={
                                  itemCoverage.automations.length === 0
                                    ? "neutral"
                                    : itemCoverage.active > 0
                                      ? "active"
                                      : "attention"
                                }
                              >
                                {itemCoverage.automations.length === 0
                                  ? t("screens.publications.coverageNone")
                                  : itemCoverage.automations.length === 1
                                    ? t(
                                        itemCoverage.active === 1
                                          ? "screens.publications.coverageOneActive"
                                          : "screens.publications.coverageOneInactive",
                                      )
                                    : t(
                                        "screens.publications.coverageMultiple",
                                        {
                                          active: itemCoverage.active,
                                          inactive: itemCoverage.inactive,
                                        },
                                      )}
                              </StatusBadge>

                              {itemCoverage.automations[0] === undefined
                                ? null
                                : (() => {
                                    const editAddress = `${AUTOMATION_FORM_ADDRESS}?id=${encodeURIComponent(itemCoverage.automations[0].id)}`;
                                    return (
                                      <ButtonLink
                                        href={editAddress}
                                        onClick={follow(editAddress)}
                                        block
                                      >
                                        {t(
                                          "screens.publications.editAutomation",
                                        )}
                                      </ButtonLink>
                                    );
                                  })()}
                            </>
                          ) : null}

                          {coveragePhase === "ready" &&
                          itemCoverage?.automations.length === 0 ? (
                            <div className="mc-pubtile__coverage-actions">
                              {/* One action per tile, and it is the one the
                                  publication is missing. It looks like the
                                  button it is: a link drawn as a sentence
                                  reads as a footnote under the picture. */}
                              <ButtonLink
                                href={createAddress}
                                onClick={follow(createAddress)}
                                variant="primary"
                                block
                              >
                                {t("screens.publications.createAutomation")}
                              </ButtonLink>
                            </div>
                          ) : null}
                        </div>
                      );
                    }
              }
            />

            <Pagination
              label={t("screens.publications.page", {
                from: total === 0 ? 0 : shown + 1,
                to: Math.min(shown + items.length, total),
                total,
              })}
              previousLabel={t("screens.publications.previous")}
              nextLabel={t("screens.publications.next")}
              atStart={shown === 0}
              atEnd={limit === 0 || shown + limit >= total}
              onPrevious={(): void => setOffset(Math.max(0, shown - limit))}
              onNext={(): void => setOffset(shown + limit)}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}

export interface PublicationsScreenProps {
  readonly client?: PublicationsClient;
  readonly coverageClient?: PublicationAutomationCoverageClient;
}

/** Field the chosen identifier lands in, and the one it can be typed into. */
const TARGET_FIELD = "publication-target";

/** The panel holding the one field: a form is easier to read narrow. */
const FORM_WIDTH: CSSProperties = { maxWidth: "var(--measure-form)" };

/**
 * The screen at `/publications`: the grid, and the identifier it feeds.
 *
 * The field is editable rather than a read-only echo, and that is REQ-072 on
 * this screen too: whichever way the grid fails, the operator still ends up
 * holding the identifier they came for. It sits ABOVE the grid, in every state,
 * for the same reason.
 */
export function PublicationsScreen({
  client,
  coverageClient,
}: PublicationsScreenProps = {}): ReactElement {
  const { t } = useLocale();
  const [target, setTarget] = useState("");
  /**
   * The identifier that came FROM the grid, which is not the same thing as the
   * field's value: an operator who types over a chosen target has chosen
   * nothing, and the tile must stop claiming it is selected.
   */
  const [chosen, setChosen] = useState<string | undefined>(undefined);

  return (
    <div className="mc-page">
      <div className="mc-page__head">
        <div className="mc-page__titles">
          <h1>{t("screens.publications.title")}</h1>
          <p className="mc-page__lead">{t("screens.publications.hint")}</p>
        </div>
      </div>

      <div className="mc-panel" style={FORM_WIDTH}>
        <Field
          id={TARGET_FIELD}
          name={TARGET_FIELD}
          type="text"
          mono
          label={t("screens.publications.target")}
          placeholder={t("screens.publications.targetPlaceholder")}
          hint={t("screens.publications.targetHint")}
          value={target}
          onChange={(event): void => {
            setTarget(event.target.value);
            setChosen(undefined);
          }}
        />

        {chosen === undefined ? null : (
          <p className="mc-source">
            <Icon name="check" size={ICON_SIZE.chip} />
            {t("screens.publications.chosen")}
          </p>
        )}
      </div>

      <PublicationPicker
        client={client}
        coverageClient={
          coverageClient ??
          (client === undefined
            ? httpPublicationAutomationCoverageClient
            : undefined)
        }
        selectedId={chosen}
        onSelect={(identifier): void => {
          setTarget(identifier);
          setChosen(identifier);
        }}
      />
    </div>
  );
}
