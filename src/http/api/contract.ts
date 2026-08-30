import type { FastifyError, FastifyInstance, FastifySchema } from "fastify";
import { t } from "../../i18n/index.js";

/**
 * The contract every route under `/api` declares, and the single definition of
 * what "declared" means (REQ-103).
 *
 * The requirement has three halves and this module owns all three, because
 * splitting them is how each one rots on its own:
 *
 *   1. DECLARING. A route is registered through `apiRoute`, which will not
 *      compile without an output schema and refuses at boot when an input
 *      channel it can receive on is left undeclared. The declaration is plain
 *      JSON Schema, the same dialect `src/http/access.ts` already uses for the
 *      session routes, so one walk over the router reads every route in the
 *      process rather than two shapes needing two readers.
 *   2. REFUSING. Fastify compiles those schemas and validates BEFORE the
 *      handler runs, so "sem alcançar a camada de domínio" holds by
 *      construction: the handler is the only thing that calls a domain
 *      function, and a refused request never enters it. `installRefusals` turns
 *      the validator's complaint into a body that names the field and the rule
 *      it broke.
 *   3. ANSWERING. The output schema is not documentation: Fastify serialises
 *      the response THROUGH it, so a field nobody declared cannot reach the
 *      interface, and a declared-required field the handler forgot raises
 *      instead of shipping a half object.
 *
 * Zod is not used here, and the reason is worth stating because Zod IS this
 * project's validation library. Zod validates the DOMAIN's definitions
 * (`src/flows/`), where the shape is deep, versioned, and the source of truth.
 * What a route declares is the ENVELOPE around such a definition, and it has to
 * be readable by the router itself: Fastify's validator and serialiser both
 * take JSON Schema, so declaring in Zod would mean converting on every route,
 * and the test that walks the registered routes would have to understand two
 * languages to answer one question. The envelope stays shallow on purpose: a
 * flow definition crosses this boundary as an opaque object and is validated by
 * `flows/`, which already reports the offending field's path.
 */

/**
 * Where the interface's contract lives. Declared here because this module is
 * the one that enforces it; `api-contract.test.ts` checks it against the
 * prefixes `access.ts` keeps private and `static.ts` refuses to answer for, so
 * the three cannot drift apart.
 */
export const API_PREFIX = "/api";

/** A JSON Schema fragment, as Fastify's validator and serialiser read it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export const STRING: JsonSchema = { type: "string" };
export const BOOLEAN: JsonSchema = { type: "boolean" };
export const INTEGER: JsonSchema = { type: "integer" };
export const NUMBER: JsonSchema = { type: "number" };

/**
 * An instant on the wire: always an ISO 8601 string, produced by the route's
 * own presenter and never by leaving a `Date` for the serialiser to interpret.
 */
export const TIMESTAMP: JsonSchema = { type: "string" };

/** Answers this contract can give. Named so no route writes a bare number. */
export const STATUS = {
  ok: 200,
  /** The request violated the declared contract. No domain function ran. */
  contractViolation: 400,
  notFound: 404,
  /** The domain refused because something else still points at the subject. */
  conflict: 409,
  /** The request was well formed and the domain refused what it carried. */
  refused: 422,
} as const;

export function arrayOf(items: JsonSchema): JsonSchema {
  return { type: "array", items };
}

/**
 * An object the caller SENDS, closed against fields nobody declared.
 *
 * `additionalProperties: { not: {} }` and not `additionalProperties: false`,
 * and the difference is real rather than stylistic. Fastify compiles input
 * schemas with `removeAdditional: true` by default, which turns the plain
 * `false` form into SILENT REMOVAL: a client that sends `enabled` where the
 * route declares `active` gets a 200 and no effect, which is the worst answer
 * available. A schema that nothing can satisfy is not covered by that removal
 * rule, so the request is refused instead, with the unknown field's own name in
 * the path (verified against Fastify 5, not assumed).
 */
export function inputObject(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: { not: {} },
  };
}

/**
 * An object the route ANSWERS with. `additionalProperties: false` here means
 * what it says: the serialiser emits the declared fields and nothing else, so
 * an internal value added to a domain result cannot leak to the interface by
 * accident.
 */
export function outputObject(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

/**
 * A refusal the DOMAIN produced: a code, plus whatever the screen needs to
 * explain it. Codes and structured data, never a sentence: the interface
 * renders its own text from the catalogue, in the operator's language.
 */
export function refusalObject(
  details: Readonly<Record<string, JsonSchema>> = {},
  requiredDetails: readonly string[] = [],
): JsonSchema {
  return outputObject({ error: STRING, ...details }, [
    "error",
    ...requiredDetails,
  ]);
}

/** Body of a contract violation. Read by the interface, never shown as is. */
export const CONTRACT_VIOLATION = "invalid_request";

/**
 * One thing the request got wrong.
 *
 * `path` names the field (`definition`, `page.limit`, `steps[0].text`) and
 * `rule` names why (`required`, `type`, `enum`, `additionalProperties`), which
 * is the "campo e motivo" of REQ-103 in machine-readable form. The validator's
 * own English sentence is deliberately NOT forwarded: it would be the one piece
 * of operator-facing text in this application that the catalogue could not
 * translate (REQ-074).
 */
export const ISSUE_SCHEMA = outputObject(
  { source: STRING, path: STRING, rule: STRING },
  ["source", "path", "rule"],
);

export const CONTRACT_VIOLATION_RESPONSE = outputObject(
  { error: STRING, issues: arrayOf(ISSUE_SCHEMA) },
  ["error", "issues"],
);

export interface ContractIssue {
  /** Which channel carried it: `body`, `querystring`, `params`, `headers`. */
  readonly source: string;
  readonly path: string;
  readonly rule: string;
}

/**
 * What a route declares. `response` is required by the type, so a route that
 * answers without saying what it answers does not compile.
 */
export interface ApiContract {
  readonly params?: JsonSchema;
  readonly querystring?: JsonSchema;
  readonly body?: JsonSchema;
  readonly response: Readonly<Record<number, JsonSchema>>;
}

/** What the handler receives, already validated against the contract above. */
export interface ApiInput<TParams, TQuery, TBody> {
  readonly params: TParams;
  readonly query: TQuery;
  readonly body: TBody;
}

export interface ApiAnswer {
  readonly status: number;
  readonly payload: unknown;
}

export type ApiHandler<TParams, TQuery, TBody> = (
  input: ApiInput<TParams, TQuery, TBody>,
) => Promise<ApiAnswer>;

export interface ApiRouteDefinition<TParams, TQuery, TBody> {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly contract: ApiContract;
  /**
   * Per-route parser ceiling. Most API requests stay under the Fastify
   * process default, while resource uploads carry a base64 envelope and need
   * a larger limit without making every endpoint accept a large body.
   */
  readonly bodyLimit?: number;
  readonly handler: ApiHandler<TParams, TQuery, TBody>;
}

/**
 * Registers one route from its contract.
 *
 * The handler never sees Fastify: it takes the validated input and returns a
 * status and a payload, which keeps every route in this directory a plain
 * function of its input and its ports.
 */
export function apiRoute<TParams = unknown, TQuery = unknown, TBody = unknown>(
  scope: FastifyInstance,
  route: ApiRouteDefinition<TParams, TQuery, TBody>,
): void {
  const contract = route.contract;

  const schema: FastifySchema = {
    ...(contract.params !== undefined && { params: contract.params }),
    ...(contract.querystring !== undefined && {
      querystring: contract.querystring,
    }),
    ...(contract.body !== undefined && { body: contract.body }),
    // The refusal is part of every contract, added here rather than repeated
    // in each route: a body the serialiser has no schema for is a 500 in place
    // of the 400 the caller needed to read.
    response: { 400: CONTRACT_VIOLATION_RESPONSE, ...contract.response },
  };

  scope.route({
    method: route.method,
    url: route.url,
    ...(route.bodyLimit !== undefined && { bodyLimit: route.bodyLimit }),
    schema,
    handler: async (request, reply) => {
      // The three casts are the boundary between an untyped wire and typed
      // code, and they are safe exactly here: Fastify validated each channel
      // against the schema declared above before this line could run.
      const answer = await route.handler({
        params: request.params as TParams,
        query: request.query as TQuery,
        body: request.body as TBody,
      });

      return reply.code(answer.status).send(answer.payload);
    },
  });
}

/** Why a registered route does not satisfy REQ-103. */
export const CONTRACT_GAPS = [
  "schema_absent",
  "output_absent",
  "output_not_declared",
  "input_body_absent",
  "input_body_not_read",
  "input_params_absent",
  "input_params_unused",
  "input_query_absent",
  "input_open",
] as const;

export type ContractGapCode = (typeof CONTRACT_GAPS)[number];

export interface ContractGap {
  readonly code: ContractGapCode;
  /** The channel or the status the gap is about, when it names one. */
  readonly at?: string;
}

/** A route as the router holds it, which is all the check needs to see. */
export interface RegisteredRoute {
  readonly method: string | readonly string[];
  readonly url: string;
  readonly schema?: FastifySchema | undefined;
}

/** Methods whose request carries a body Fastify parses and can validate. */
const METHODS_WITH_BODY = ["POST", "PUT", "PATCH"];

/** Methods whose entire input is the address: no body is ever read from them. */
const METHODS_WITHOUT_BODY = ["GET", "HEAD"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function methodsOf(route: RegisteredRoute): string[] {
  const declared = Array.isArray(route.method) ? route.method : [route.method];
  return declared.map((method) => String(method).toUpperCase());
}

/** Whether the address itself carries input: `/api/flows/:id`, `/api/x/*`. */
export function urlCarriesParameters(url: string): boolean {
  return url.includes(":") || url.includes("*");
}

/**
 * Whether an input schema is closed, meaning no undeclared field reaches the
 * handler. Both closed forms count: `false` (Fastify strips the field) and a
 * schema nothing satisfies (Fastify refuses the request). `inputObject` writes
 * the second, and the first is accepted because it also closes the object.
 */
function isClosed(schema: Record<string, unknown>): boolean {
  const additional = schema["additionalProperties"];
  return additional === false || asRecord(additional) !== undefined;
}

/**
 * Everything wrong with one route's declaration, empty when there is nothing.
 *
 * ONE definition, TWO enforcement points, deliberately. `registerApiRoutes`
 * hangs it on an `onRoute` hook, so a route registered inside the API scope
 * without a contract stops the process at boot, whether or not it went through
 * `apiRoute`. And `api-contract.test.ts` walks every route the composed
 * application registers, which is the wider net: it also covers routes
 * registered under `/api` by modules that never enter this scope at all.
 */
export function contractGaps(route: RegisteredRoute): readonly ContractGap[] {
  const schema = asRecord(route.schema);

  if (schema === undefined) {
    return [{ code: "schema_absent" }];
  }

  const gaps: ContractGap[] = [];
  const response = asRecord(schema["response"]);

  if (response === undefined || Object.keys(response).length === 0) {
    gaps.push({ code: "output_absent" });
  } else {
    for (const [status, declared] of Object.entries(response)) {
      // `{ type: "null" }` for a 204 is a declaration; `true`, `{}` or a
      // missing entry is a status the route answers with and never described.
      const entry = asRecord(declared);
      if (entry === undefined || Object.keys(entry).length === 0) {
        gaps.push({ code: "output_not_declared", at: status });
      }
    }
  }

  const methods = methodsOf(route);
  const carriesBody = methods.some((method) =>
    METHODS_WITH_BODY.includes(method),
  );
  const addressOnly = methods.every((method) =>
    METHODS_WITHOUT_BODY.includes(method),
  );

  if (carriesBody && schema["body"] === undefined) {
    gaps.push({ code: "input_body_absent" });
  }

  if (addressOnly && schema["body"] !== undefined) {
    // A body schema on a GET is a contract nobody can satisfy: the request has
    // no body to validate, so the route promises a check that never runs.
    gaps.push({ code: "input_body_not_read" });
  }

  const parameterised = urlCarriesParameters(route.url);

  if (parameterised && schema["params"] === undefined) {
    gaps.push({ code: "input_params_absent" });
  }

  if (!parameterised && schema["params"] !== undefined) {
    gaps.push({ code: "input_params_unused" });
  }

  if (addressOnly && schema["querystring"] === undefined) {
    // A GET reads its input from the address and nowhere else, so one that
    // declares no query string has declared no input at all. Declaring an
    // empty object is the honest way to say "this route takes no parameters",
    // and it is enforced: an unexpected one is refused instead of ignored.
    gaps.push({ code: "input_query_absent" });
  }

  for (const channel of ["body", "querystring", "params"]) {
    const declared = asRecord(schema[channel]);
    if (declared !== undefined && !isClosed(declared)) {
      gaps.push({ code: "input_open", at: channel });
    }
  }

  return gaps;
}

/** The gaps as one label, for a boot refusal or a test failure to carry. */
export function describeGaps(gaps: readonly ContractGap[]): string {
  return gaps
    .map((gap) => (gap.at === undefined ? gap.code : `${gap.code}(${gap.at})`))
    .join(", ");
}

/** Every route the router holds, for whoever walks them. */
export function routeLabel(route: RegisteredRoute): string {
  return `${methodsOf(route).join("|")} ${route.url}`;
}

const JSON_POINTER_ESCAPES: readonly (readonly [string, string])[] = [
  ["~1", "/"],
  ["~0", "~"],
];

function decodePointerSegment(segment: string): string {
  return JSON_POINTER_ESCAPES.reduce(
    (decoded, [escaped, character]) => decoded.split(escaped).join(character),
    segment,
  );
}

/**
 * The field's path in the shape an operator wrote it: `steps[0].text`.
 *
 * The same notation `src/flows/validation.ts` reports domain issues with, so a
 * screen shows one kind of path whichever layer refused. Two validator
 * complaints name a field that is NOT in the instance path, and both are the
 * ones that matter most here: a missing required field, and a field the
 * contract never declared. Their names are pulled out of the parameters, or the
 * answer would point at the container and leave the operator hunting.
 */
function pathOf(error: {
  instancePath: string;
  keyword: string;
  params: Record<string, unknown>;
}): string {
  const segments = error.instancePath
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodePointerSegment);

  const missing = error.params["missingProperty"];
  if (error.keyword === "required" && typeof missing === "string") {
    segments.push(missing);
  }

  return segments.reduce<string>((path, segment) => {
    if (/^\d+$/.test(segment)) {
      return `${path}[${segment}]`;
    }
    return path === "" ? segment : `${path}.${segment}`;
  }, "");
}

/** Where the closed-object refusal shows up in the schema it came from. */
const UNKNOWN_FIELD_SCHEMA_PATH = "/additionalProperties/not";

function ruleOf(error: { keyword: string; schemaPath: string }): string {
  // The closed form of `inputObject` reports `not`, which says nothing on its
  // own. Reported as what it is: a field this contract does not declare.
  return error.schemaPath.endsWith(UNKNOWN_FIELD_SCHEMA_PATH)
    ? "additionalProperties"
    : error.keyword;
}

/**
 * A body the parser could not read at all, which never reaches the validator
 * and so carries no field of its own.
 */
const UNREADABLE_BODY_RULE = "malformed";

export function issuesOf(error: FastifyError): readonly ContractIssue[] {
  const source = error.validationContext ?? "body";
  const validation = error.validation;

  if (validation === undefined || validation.length === 0) {
    // The parser refused the bytes, so there is no field to point at: the whole
    // body is what was wrong, and the reason is the code the parser raised.
    const rule =
      typeof error.code === "string" && error.code !== ""
        ? error.code
        : UNREADABLE_BODY_RULE;

    return [{ source, path: "", rule }];
  }

  return validation.map((failure) => ({
    source,
    path: pathOf(failure),
    rule: ruleOf(failure),
  }));
}

/**
 * Turns the router's refusals into the declared 400 body.
 *
 * Installed on the API scope only, so nothing outside it changes shape. Every
 * 400 that reaches here was raised before the handler: a schema violation, or a
 * body the parser could not read. Anything else is handed back to Fastify
 * untouched, because inventing a contract answer for an error the contract
 * never described would hide it.
 */
export function installRefusals(scope: FastifyInstance): void {
  scope.setErrorHandler((error: FastifyError, _request, reply) => {
    if ((error.statusCode ?? 0) !== STATUS.contractViolation) {
      return reply.send(error);
    }

    return reply
      .code(STATUS.contractViolation)
      .send({ error: CONTRACT_VIOLATION, issues: issuesOf(error) });
  });
}

/**
 * Refuses at boot a route registered under this scope with an incomplete
 * contract, whichever way it was registered.
 *
 * The same shape as the private-scope guard in `access.ts` and for the same
 * reason: a rule checked when the process starts cannot be forgotten by the
 * next route, and the failure is loud and immediate instead of arriving as a
 * screen consuming a contract that was never there.
 */
export function guardContracts(scope: FastifyInstance): void {
  scope.addHook("onRoute", (route) => {
    const gaps = contractGaps(route);

    if (gaps.length > 0) {
      throw new Error(
        t("api.contractIncomplete", {
          route: routeLabel(route),
          prefix: API_PREFIX,
          gaps: describeGaps(gaps),
        }),
      );
    }
  });
}
