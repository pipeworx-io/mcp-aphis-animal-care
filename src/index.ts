interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * APHIS Animal Care MCP — USDA Animal Welfare Act licensees, registrants and
 * Animal Care inspection reports.
 *
 * Tools:
 * - aphis_licensee_search: who holds an AWA licence/registration — commercial
 *   dog breeders (Class A), dealers, exhibitors, carriers, research
 *   facilities — by state, licence class, city, ZIP, name or certificate
 *   number.
 * - aphis_inspection_reports: Animal Care inspection reports with their
 *   critical / direct / non-critical violation counts and a link to the
 *   official PDF, filterable by animal category (DOGS, CATS, ...) and by the
 *   specific AWA regulation cited.
 * - aphis_inspection_filter_options: the animal categories and the 2,165 AWA
 *   citation section codes the inspection filters accept.
 *
 * Source: the USDA APHIS eFile Public Search Tool
 * (efile.aphis.usda.gov/PublicSearchTool), the same public register the
 * agency serves to any visitor. This is the official federal accountability
 * record for Animal Welfare Act enforcement.
 *
 * HOW THIS TALKS TO THE UPSTREAM, because it does not look like a REST API.
 * The Public Search Tool is a Salesforce Lightning community, and its search
 * runs over the Aura endpoint at /PublicSearchTool/s/sfsites/aura as
 * `apex://EFL_PSTController`. There is no documented REST API and no key.
 * The Apex class and its three methods (doCustomerQuery, doIRSearch_UI,
 * getSearchSetup / getIRSearchFilters) were captured by driving one real
 * search in a browser and reading the request off the wire — see
 * docs/reference/aphis-animal-care/.
 *
 * TRAP #1 — the refusal that is not a refusal. A request to this endpoint
 * with a missing or malformed `aura.context` comes back
 * `{"exceptionMessage":"Guest user access is not allowed"}` with descriptor
 * `aura:invalidSession`. That reads as a hard policy block on anonymous
 * callers and it is NOT one: the endpoint serves guests fine. It is only
 * ever a malformed envelope. Measured 2026-09-05: `aura.context` needs
 * nothing beyond `{"mode":"PROD","app":"siteforce:communityApp"}` — no
 * session, no cookies, no CSRF token, and notably NO valid `fwuid`. A
 * deliberately bogus fwuid and an omitted fwuid both return SUCCESS, so this
 * pack does not scrape one off the page and cannot break when Salesforce
 * rolls its framework version.
 *
 * TRAP #2 — `index` is a PAGE NUMBER, not a row offset, and the upstream
 * caps the underlying SOQL offset at 2,000 rows. So page * page_size must
 * stay under 2,000: with the default 20 rows you can reach page 99, with 100
 * rows only page 19. Past that the upstream throws
 * "Maximum SOQL offset allowed for apiName EFLLicense__c is 2000" — this
 * pack refuses that combination up front with the reachable page instead of
 * relaying a raw Salesforce stack trace. `total` is still the true unpaged
 * count (4,986 Class A breeder licences in Missouri alone), so callers can
 * see how much lies beyond the reachable window and narrow instead.
 *
 * TRAP #3 — the inspection filters are singular, not plural. `irFilterCriteria`
 * takes `animalCategory` and `sectionCode` as SINGLE Salesforce ids. Passing
 * the plural `animalCategories: [id]` is silently IGNORED — it returns the
 * unfiltered count with a 200, which is the worst shape of wrong answer, so
 * this pack only ever sends the singular keys. No date-range key exists on
 * this filter at all (inspectionDateFrom / fromDate / startDate are all
 * ignored); date narrowing has to happen caller-side on `inspection_date`,
 * and the tool says so rather than accepting a date argument it cannot honour.
 *
 * TRAP #4 — a licence record is not a business. The same person appears once
 * per certificate, so a name legitimately repeats across rows with different
 * certificate numbers and statuses (Active / Cancelled / Revoked). Most rows
 * in any state are CANCELLED historical licences; a search for "licensed
 * breeders in X" that does not filter on status will mostly return people who
 * are no longer licensed. `status: "active"` is the argument for that, and
 * the response always reports how many of the matched rows were active.
 *
 * TRAP #5 — there is NO server-side status filter, and asking for one is a
 * silent zero in the other direction. `certStatus`, `status`,
 * `certificateStatus`, `licenseStatus`, `isActive` and `activeOnly` are all
 * accepted and all silently IGNORED — each returns the full unfiltered count
 * with a 200. Worse, active rows are genuinely sparse and are not sorted to
 * the front: measured 2026-09-05 for Class A breeders in Missouri, 75 active
 * out of the 2,000 rows a caller can reach, only 4 of them on page 1. So
 * filtering one page caller-side answers "who is a licensed dog breeder in
 * Missouri" with an empty list while 4,986 records sit upstream — the exact
 * silent-zero shape that looks like a clean "none". `status: "active"`
 * therefore SCANS: it pulls up to SCAN_BUDGET pages of SCAN_ROWS and collects
 * active rows until it has `limit` of them, then reports how many rows it
 * actually read (`scanned_rows`) and whether it stopped early. That costs
 * several upstream requests for one tool call, which is why it is bounded and
 * why the unfiltered default stays a single request.
 */


const UA = 'pipeworx-mcp-aphis-animal-care/1.0 (+https://pipeworx.io)';
const AURA = 'https://efile.aphis.usda.gov/PublicSearchTool/s/sfsites/aura';
const PAGE_URI = '/PublicSearchTool/s/inspection-reports';
const SOURCE = 'USDA APHIS eFile Public Search Tool (efile.aphis.usda.gov/PublicSearchTool)';

/** Upstream caps the SOQL offset behind `index`; see TRAP #2. */
const MAX_OFFSET = 2000;

/** Rows per upstream request while scanning for active certificates; see TRAP #5. */
const SCAN_ROWS = 100;
/** How many of those scans one `status:"active"` call may spend. */
const SCAN_BUDGET = 6;

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'APHIS eFile');
}

/**
 * Call one `apex://EFL_PSTController` action as a guest.
 *
 * The envelope is deliberately minimal (see TRAP #1) — every field here was
 * confirmed necessary, and everything the browser also sends (fwuid, loaded
 * app version, aura.token) was confirmed unnecessary.
 */
async function apex<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const body = new URLSearchParams({
    message: JSON.stringify({
      actions: [
        {
          id: '134;a',
          descriptor: `apex://EFL_PSTController/ACTION$${method}`,
          callingDescriptor: 'markup://c:EFL_PSTSearchResults',
          params,
          version: null,
        },
      ],
    }),
    'aura.context': JSON.stringify({ mode: 'PROD', app: 'siteforce:communityApp' }),
    'aura.pageURI': PAGE_URI,
    'aura.token': 'null',
  });

  const res = await pwFetch(`${AURA}?r=1&other.EFL_PST.${method}=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: `https://efile.aphis.usda.gov${PAGE_URI}`,
    },
    body,
  });
  if (!res.ok) throw await httpError(res, 'APHIS eFile');

  // The Aura endpoint answers a malformed envelope with an HTML error page on a
  // 200, so the JSON parse needs the shared handler rather than a bare
  // JSON.parse — that is the "200 with markup" case parseJson exists for.
  const payload = await parseJson<{
    actions?: { state?: string; returnValue?: T; error?: { message?: string }[] }[];
    exceptionMessage?: string;
  }>(res, 'APHIS eFile');

  if (payload.exceptionMessage) {
    throw new Error(`APHIS eFile rejected the ${method} request: ${payload.exceptionMessage}`);
  }
  const action = payload.actions?.[0];
  if (!action || action.state !== 'SUCCESS') {
    const detail = action?.error?.map((e) => e?.message).filter(Boolean).join('; ');
    throw new Error(`APHIS eFile ${method} failed${detail ? `: ${detail}` : ` (state ${action?.state ?? 'missing'})`}`);
  }
  return action.returnValue as T;
}

/* ── Vocabularies, resolved live rather than hardcoded ────────────── */

type Option = { label: string; value: string };
type SearchSetup = { states: Option[]; types: Option[]; years?: unknown };
type IrFilters = { animalCategories: Option[]; sectionCodes: Option[] };

// Per-invocation memo only — packs are stateless and the gateway may reuse an
// isolate, so this is a request-shaped saving, not a cache of upstream data.
let setupMemo: Promise<SearchSetup> | null = null;
let filtersMemo: Promise<IrFilters> | null = null;

const getSetup = (): Promise<SearchSetup> => (setupMemo ??= apex<SearchSetup>('getSearchSetup', {}));
const getFilters = (): Promise<IrFilters> => (filtersMemo ??= apex<IrFilters>('getIRSearchFilters', {}));

const norm = (s: string): string => s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/**
 * States come back labelled "MISSOURI (MO)". Accept either half — a caller
 * asking about "dog breeders in Missouri" and one passing "MO" both work.
 */
function resolveState(input: string, states: Option[]): Option {
  const want = norm(input);
  const hit =
    states.find((s) => {
      const m = /^(.*)\s+\(([A-Z]{2})\)$/.exec(s.label);
      return m ? norm(m[1]) === want || m[2] === want : false;
    }) ?? states.find((s) => norm(s.label).startsWith(want));
  if (!hit) {
    const names = states.map((s) => s.label.replace(/\s*\(([A-Z]{2})\)$/, ' → $1')).join(', ');
    throw new Error(`Unknown state "${input}". APHIS covers: ${names}`);
  }
  return hit;
}

/**
 * Licence classes invert the usual label/value sense: upstream sends
 * `{label: "BREEDER", value: "Class A - Breeder"}`, and it is the VALUE that
 * has to go on the wire as `certType`. Sending the label instead is a silent
 * zero — an exact-match field that matches nothing, returned as a clean 200
 * with an empty list. Accept the short form, the full form, or the bare class
 * letter, and always send `.value`.
 */
function resolveType(input: string, types: Option[]): Option {
  const want = norm(input);
  const hit =
    types.find((t) => norm(t.value) === want || norm(t.label) === want) ??
    // A bare class letter, before any substring matching — "A" is a substring
    // of nearly every label, so a loose pass would resolve it to the wrong class.
    (/^[A-Z]$/.test(want) ? types.find((t) => new RegExp(`^CLASS ${want}\\b`).test(norm(t.value))) : undefined) ??
    types.find((t) => norm(t.label).includes(want) || norm(t.value).includes(want));
  if (!hit) {
    throw new Error(`Unknown licence type "${input}". Valid types: ${types.map((t) => `${t.label} (${t.value})`).join(', ')}`);
  }
  return hit;
}

function resolveOption(input: string, opts: Option[], what: string, sample = 12): Option {
  const want = norm(input);
  const hit =
    opts.find((o) => norm(o.label) === want) ??
    opts.find((o) => norm(o.label).startsWith(want)) ??
    opts.find((o) => norm(o.label).includes(want));
  if (!hit) {
    throw new Error(
      `Unknown ${what} "${input}". ${opts.length} are available, e.g. ${opts.slice(0, sample).map((o) => o.label).join(', ')}. Call aphis_inspection_filter_options to search the full list.`,
    );
  }
  return hit;
}

/* ── Shared argument handling ─────────────────────────────────────── */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Guard TRAP #2 before the upstream throws a raw Salesforce stack trace. */
function assertReachable(page: number, size: number): void {
  if (page * size <= MAX_OFFSET) return;
  const lastPage = Math.floor(MAX_OFFSET / size);
  throw new Error(
    `Page ${page} at ${size} rows/page is past the upstream's hard limit of ${MAX_OFFSET} rows into a result set (page * page_size must be <= ${MAX_OFFSET}). At this page_size the last reachable page is ${lastPage}. Narrow the search (add a state, city, ZIP, licence type or name) rather than paging deeper — "total" tells you how many matches exist beyond the reachable window.`,
  );
}

type Criteria = Record<string, unknown>;

/** Build the shared searchCriteria both actions take. */
async function buildCriteria(args: Record<string, unknown>, page: number, size: number): Promise<{ criteria: Criteria; applied: Record<string, string> }> {
  const criteria: Criteria = { index: page, numberOfRows: size };
  const applied: Record<string, string> = {};

  const state = str(args.state);
  const type = str(args.license_type);
  if (state || type) {
    const setup = await getSetup();
    if (state) {
      const hit = resolveState(state, setup.states);
      criteria.state = hit.value;
      applied.state = hit.label;
    }
    if (type) {
      const hit = resolveType(type, setup.types);
      criteria.certType = hit.value;
      applied.license_type = hit.value;
    }
  }
  const pairs: [string, string][] = [
    ['customerName', 'name'],
    ['city', 'city'],
    ['zip', 'zip'],
    ['certNumber', 'certificate_number'],
    ['customerNumber', 'customer_number'],
  ];
  for (const [key, arg] of pairs) {
    const v = str(args[arg]);
    if (v) {
      criteria[key] = v;
      applied[arg] = v;
    }
  }
  return { criteria, applied };
}

/* ── Tool definitions ─────────────────────────────────────────────── */

const tools: McpToolExport['tools'] = [
  {
    name: 'aphis_licensee_search',
    description:
      'Find USDA Animal Welfare Act licence and registration holders — commercial dog breeders (Class A), animal dealers (Class B), exhibitors/zoos (Class C), carriers, intermediate handlers and research facilities. Answers "USDA licensed dog breeders in Missouri", "who holds an AWA exhibitor licence in Texas", "look up certificate 43-A-6814", "is this kennel USDA licensed". Returns the licensee name, certificate number, licence class, certificate status (Active / Cancelled / Revoked) and facility city/county/ZIP. Sourced from the USDA APHIS eFile Public Search Tool, the official federal register of AWA licensees. NOTE: most rows in any state are CANCELLED historical licences — pass status:"active" for currently licensed holders only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string', description: 'State name or two-letter code, e.g. "Missouri" or "MO". Covers all 50 states plus DC, PR, GU, VI, AS and MP.' },
        license_type: { type: 'string', description: 'Licence class, e.g. "BREEDER" (Class A, commercial dog/animal breeders), "DEALER" (Class B), "EXHIBITOR" (Class C), "RESEARCH FACILITY", "CARRIER", "INTERMEDIATE HANDLER". The full label ("Class A - Breeder") and the bare letter ("A") also work.' },
        name: { type: 'string', description: 'Customer / organization name, partial match, e.g. "KENNEL", "Royal Canin".' },
        city: { type: 'string', description: 'Facility city, e.g. "Springfield".' },
        zip: { type: 'string', description: 'Facility ZIP code.' },
        certificate_number: { type: 'string', description: 'Exact certificate number in the form XX-X-XXXX, e.g. "43-A-6814".' },
        customer_number: { type: 'string', description: 'APHIS customer number, e.g. "4315".' },
        kind: { type: 'string', description: '"license" (default — Class A/B/C licensees, incl. breeders and exhibitors) or "registration" (registrants: research facilities, carriers, intermediate handlers).' },
        status: { type: 'string', description: '"all" (default) or "active" for currently-active certificates only. Use "active" for any "who is licensed" question: most rows in this register are Cancelled historical licences and the upstream neither filters nor sorts by status, so the default page is usually all-inactive. "active" cannot be combined with "page".' },
        limit: { type: 'number', description: 'Rows per page (1-100, default 20).' },
        page: { type: 'number', description: '0-based page number (default 0). page * limit must stay <= 2000 — an upstream hard cap.' },
      },
      required: [],
    },
  },
  {
    name: 'aphis_inspection_reports',
    description:
      'Search USDA APHIS Animal Care inspection reports — the inspections behind Animal Welfare Act enforcement. Answers "inspection reports for USDA dog breeders in Missouri", "which breeders had critical violations", "show me inspections citing 3.1(a) housing", "inspection history for certificate 43-A-6814". Each report carries the inspection date, the licensee and facility location, counts of critical / direct / non-critical violations and teachable moments, and report_pdf_url — a direct link to the official signed inspection report. Sourced from the USDA APHIS eFile Public Search Tool. Filter by animal_category (e.g. "DOGS") or by the specific regulation cited; there is no date filter upstream, so narrow by inspection_date on the returned rows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string', description: 'State name or two-letter code, e.g. "Missouri" or "MO".' },
        license_type: { type: 'string', description: 'Licence class of the inspected facility, e.g. "BREEDER", "EXHIBITOR", "DEALER", "RESEARCH FACILITY".' },
        name: { type: 'string', description: 'Customer / organization name, partial match.' },
        city: { type: 'string', description: 'Facility city.' },
        zip: { type: 'string', description: 'Facility ZIP code.' },
        certificate_number: { type: 'string', description: 'Exact certificate number, e.g. "43-A-6814" — the inspection history for one licensee.' },
        customer_number: { type: 'string', description: 'APHIS customer number.' },
        animal_category: { type: 'string', description: 'Restrict to inspections covering this animal category, e.g. "DOGS", "CATS", "NONHUMAN PRIMATES", "MARINE MAMMALS". Call aphis_inspection_filter_options for all 34.' },
        citation: { type: 'string', description: 'Restrict to inspections citing this AWA regulation section, e.g. "3.1(a)" or "3.1(a) - Housing facilities, general". 2,165 section codes exist — call aphis_inspection_filter_options with a query to find the right one.' },
        teachable_moments_only: { type: 'boolean', description: 'Only inspections that recorded a teachable moment (an issue corrected on the spot rather than cited). Default false.' },
        limit: { type: 'number', description: 'Rows per page (1-100, default 20).' },
        page: { type: 'number', description: '0-based page number (default 0). page * limit must stay <= 2000 — an upstream hard cap.' },
      },
      required: [],
    },
  },
  {
    name: 'aphis_inspection_filter_options',
    description:
      'List the filter vocabularies aphis_inspection_reports accepts: the 34 animal categories (DOGS, CATS, NONHUMAN PRIMATES, MARINE MAMMALS, ...) and the 2,165 Animal Welfare Act citation section codes (e.g. "3.1(a) - Housing facilities, general"). Use this to find the exact citation string before filtering an inspection search. Sourced from the USDA APHIS eFile Public Search Tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Filter both lists to entries containing this text, e.g. "3.1", "housing", "primate", "veterinary care".' },
        kind: { type: 'string', description: '"all" (default), "animals" for animal categories only, or "citations" for AWA section codes only.' },
        limit: { type: 'number', description: 'Max entries per list (1-500, default 50).' },
      },
      required: [],
    },
  },
];

/* ── Tool implementations ─────────────────────────────────────────── */

type LicenseeRow = {
  accountName?: string;
  addressLine1?: string;
  addressLine3?: string;
  addressLine4?: string;
  certNumber?: string;
  certStatus?: string;
  certType?: string;
  customerNumber?: string;
  parentId?: string;
  statusDate?: string;
};

type QueryResult<T> = { results?: T[]; totalCount?: number };

async function licenseeSearch(args: Record<string, unknown>): Promise<unknown> {
  const size = clampInt(args.limit, 20, 1, 100);
  const page = clampInt(args.page, 0, 0, 10_000);
  assertReachable(page, size);

  const kind = str(args.kind)?.toLowerCase();
  const sObjectType = kind === 'registration' || kind === 'registrations' || kind === 'registrant' ? 'EFLRegistration__c' : 'EFLLicense__c';
  const activeOnly = str(args.status)?.toLowerCase() === 'active';

  if (activeOnly && page > 0) {
    throw new Error(
      'status:"active" scans from the start of the result set (the upstream has no status filter and does not sort active certificates to the front), so it cannot be combined with "page". Narrow the search with city, ZIP, name or licence type instead, or drop status:"active" and page through everything.',
    );
  }

  const { criteria, applied } = await buildCriteria(args, page, activeOnly ? SCAN_ROWS : size);
  const query = (c: Criteria): Promise<QueryResult<LicenseeRow>> =>
    apex<QueryResult<LicenseeRow>>('doCustomerQuery', { searchCriteria: c, sObjectType, getCount: true });

  const first = await query(criteria);
  const rows = first.results ?? [];
  const total = first.totalCount ?? 0;

  // TRAP #5: no server-side status filter and active rows are sparse, so
  // "active" has to read forward rather than filter one page to nothing.
  let shown = rows;
  let scanned = rows.length;
  let truncated = false;
  if (activeOnly) {
    shown = rows.filter((r) => r.certStatus === 'Active');
    for (let p = 1; p < SCAN_BUDGET && shown.length < size; p++) {
      if (p * SCAN_ROWS > MAX_OFFSET || scanned >= total) break;
      const next = await query({ ...criteria, index: p });
      const batch = next.results ?? [];
      if (batch.length === 0) break;
      scanned += batch.length;
      shown = shown.concat(batch.filter((r) => r.certStatus === 'Active'));
    }
    truncated = shown.length < size && scanned < Math.min(total, MAX_OFFSET);
    shown = shown.slice(0, size);
  }
  const activeCount = rows.filter((r) => r.certStatus === 'Active').length;

  return {
    source: SOURCE,
    record_type: sObjectType === 'EFLRegistration__c' ? 'registration' : 'license',
    filters_applied: { ...applied, ...(activeOnly ? { status: 'Active only' } : {}) },
    total,
    page,
    page_size: size,
    returned: shown.length,
    ...(activeOnly ? { scanned_rows: scanned } : { active_on_this_page: activeCount }),
    licensees: shown.map((r) => ({
      name: r.accountName,
      certificate_number: r.certNumber,
      license_type: r.certType,
      status: r.certStatus,
      status_date: r.statusDate,
      customer_number: r.customerNumber,
      address: r.addressLine1,
      city_state_zip: r.addressLine3,
      county: r.addressLine4,
      // Opaque upstream id; carried because the inspection search keys on it.
      licensee_id: r.parentId,
    })),
    status_date_note:
      'status_date means different things per status: for an Active certificate it is the expiry/renewal date, for a Cancelled or Revoked one the date it ended.',
    ...(rows.length === 0
      ? { note: 'No AWA licence records matched. A zero here means no record in the APHIS eFile register under these criteria — check the state and licence type, or drop a filter and narrow again.' }
      : {}),
    ...(activeOnly && shown.length === 0 && rows.length > 0
      ? { note: `Read ${scanned} of the ${total} matching records and found no Active certificate — these are historical Cancelled/Revoked licences. Most records in this register are historical; narrow by city, ZIP or name to search a different part of the result set, or drop status:"active" to see them all.` }
      : {}),
    ...(activeOnly && truncated
      ? { scan_note: `Stopped after reading ${scanned} of ${total} matching records (the per-call scan budget) with ${shown.length} active found. There are very likely more active certificates further into the result set — narrow by city, ZIP or name to reach them.` }
      : {}),
    ...(!activeOnly && activeCount === 0 && rows.length > 0
      ? { note: 'None of the matches on this page are currently active — these are historical Cancelled/Revoked certificates. Pass status:"active" to search for current licence holders; the upstream does not sort active ones to the front, so this pack scans forward for them.' }
      : {}),
    ...(total > MAX_OFFSET
      ? { pagination_note: `${total} matches, but the upstream only lets a caller read ${MAX_OFFSET} rows into a result set. Narrow by city, ZIP, licence type or name to reach the rest.` }
      : {}),
  };
}

type InspectionRow = {
  certNumber?: string;
  certType?: string;
  city?: string;
  state?: string;
  zip?: string;
  critical?: number;
  direct?: number;
  nonCritical?: number;
  teachableMoments?: number;
  customerNumber?: string;
  inspectionDate?: string;
  inspectionDateString?: string;
  legalName?: string;
  siteName?: string;
  reportLink?: string;
};

async function inspectionReports(args: Record<string, unknown>): Promise<unknown> {
  const size = clampInt(args.limit, 20, 1, 100);
  const page = clampInt(args.page, 0, 0, 10_000);
  assertReachable(page, size);

  const { criteria, applied } = await buildCriteria(args, page, size);

  // Both filter keys are SINGULAR single ids — see TRAP #3.
  const irFilter: Record<string, string> = {};
  const animal = str(args.animal_category);
  const citation = str(args.citation);
  if (animal || citation) {
    const filters = await getFilters();
    if (animal) {
      const hit = resolveOption(animal, filters.animalCategories, 'animal category');
      irFilter.animalCategory = hit.value;
      applied.animal_category = hit.label;
    }
    if (citation) {
      const hit = resolveOption(citation, filters.sectionCodes, 'citation section code', 6);
      irFilter.sectionCode = hit.value;
      applied.citation = hit.label;
    }
  }
  const teachableOnly = args.teachable_moments_only === true;
  if (teachableOnly) applied.teachable_moments_only = 'true';

  const out = await apex<QueryResult<InspectionRow>>('doIRSearch_UI', {
    searchCriteria: criteria,
    hasTeachableMoments: teachableOnly,
    getCount: true,
    irFilterCriteria: Object.keys(irFilter).length ? irFilter : null,
  });

  const rows = out.results ?? [];
  return {
    source: SOURCE,
    filters_applied: applied,
    total: out.totalCount ?? 0,
    page,
    page_size: size,
    returned: rows.length,
    inspections: rows.map((r) => ({
      licensee: r.legalName,
      site_name: r.siteName,
      certificate_number: r.certNumber,
      license_type: r.certType,
      inspection_date: r.inspectionDate,
      city: r.city,
      state: r.state,
      zip: r.zip,
      critical_violations: r.critical,
      direct_violations: r.direct,
      non_critical_violations: r.nonCritical,
      teachable_moments: r.teachableMoments,
      customer_number: r.customerNumber,
      report_pdf_url: r.reportLink,
    })),
    violations_note:
      'critical / direct / non-critical are APHIS severity classes for cited Animal Welfare Act noncompliance; "direct" means the issue was directly affecting animal health or wellbeing at the time. A count of 0 across all three means the inspection found no cited noncompliance. The full findings are only in report_pdf_url.',
    ...(rows.length === 0
      ? { note: 'No inspection reports matched. A zero here means no report in the APHIS eFile register under these criteria — a licensee with no rows may simply not have been inspected in the published window, which is not the same as a clean record.' }
      : {}),
    ...((out.totalCount ?? 0) > MAX_OFFSET
      ? { pagination_note: `${out.totalCount} matches, but the upstream only lets a caller page ${MAX_OFFSET} rows deep. Narrow by state, licence type, certificate number or citation to reach the rest.` }
      : {}),
    date_filter_note: 'The upstream inspection search accepts no date range — filter the returned rows on inspection_date instead.',
  };
}

async function filterOptions(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampInt(args.limit, 50, 1, 500);
  const q = str(args.query);
  const kind = str(args.kind)?.toLowerCase() ?? 'all';
  const filters = await getFilters();

  const match = (o: Option): boolean => (q ? o.label.toUpperCase().includes(q.toUpperCase()) : true);
  const animals = filters.animalCategories.filter(match);
  const citations = filters.sectionCodes.filter(match);

  return {
    source: SOURCE,
    query: q ?? null,
    ...(kind === 'citations'
      ? {}
      : {
          animal_categories: { total: filters.animalCategories.length, matched: animals.length, values: animals.slice(0, limit).map((o) => o.label) },
        }),
    ...(kind === 'animals'
      ? {}
      : {
          citation_section_codes: { total: filters.sectionCodes.length, matched: citations.length, values: citations.slice(0, limit).map((o) => o.label) },
        }),
    note: 'Pass any of these labels straight to aphis_inspection_reports as animal_category or citation — the tool resolves the label to the id the upstream wants.',
  };
}

/* ── callTool dispatcher ──────────────────────────────────────────── */

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'aphis_licensee_search':
      return licenseeSearch(args);
    case 'aphis_inspection_reports':
      return inspectionReports(args);
    case 'aphis_inspection_filter_options':
      return filterOptions(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
