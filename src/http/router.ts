/**
 * A tiny, dependency-free path router — the pure core of Posthorn's HTTP layer.
 *
 * Matching a request to a handler is decision logic, not I/O, so it lives here as
 * a pure function ({@link matchRoute}) that takes a method + pathname and returns
 * a verdict. Keeping it pure means the whole route table is exhaustively
 * unit-testable without sockets, exactly mirroring how the delivery worker keeps
 * its `buildSignedRequest`/`isSuccessStatus` decisions pure and its socket I/O in a
 * thin adapter.
 *
 * Patterns are written as slash-separated segments; a segment beginning with `:`
 * is a named parameter that captures one (URL-decoded, non-empty) path segment,
 * e.g. `/v1/endpoints/:id`. There is no wildcard/splat — the API surface is small
 * and explicit on purpose.
 *
 * The match distinguishes three outcomes so the HTTP layer can answer correctly:
 * a method+path hit (`matched`), a path that exists under a *different* method
 * (`methodNotAllowed`, which must carry an `Allow` header), and neither
 * (`notFound`).
 */

/** Captured path parameters, keyed by the `:name` in the pattern. */
export type RouteParams = Readonly<Record<string, string>>;

/** A single compiled route: an upper-cased method, the split pattern, and its handler. */
export interface Route<H> {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: H;
}

/** A route definition as written by a caller, before compilation. */
export interface RouteDef<H> {
  /** HTTP method; compared case-insensitively. */
  readonly method: string;
  /** Slash-separated pattern, e.g. `/v1/endpoints/:id`. */
  readonly pattern: string;
  readonly handler: H;
}

/** The outcome of {@link matchRoute}. */
export type RouteMatch<H> =
  | { readonly kind: "matched"; readonly handler: H; readonly params: RouteParams }
  | { readonly kind: "notFound" }
  | { readonly kind: "methodNotAllowed"; readonly allow: readonly string[] };

/**
 * Split a pathname into its meaningful segments: leading and trailing slashes are
 * ignored, so `/`, `/v1/endpoints`, and `/v1/endpoints/` normalize predictably.
 * Pure and shared by both compilation and matching so a pattern and a request path
 * are segmented the same way.
 */
export function toSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** Compile route definitions into matchable {@link Route}s (segments pre-split). */
export function defineRoutes<H>(defs: readonly RouteDef<H>[]): readonly Route<H>[] {
  return defs.map((def) => ({
    method: def.method.toUpperCase(),
    segments: toSegments(def.pattern),
    handler: def.handler,
  }));
}

/**
 * Try to match one route's pattern segments against the request segments,
 * returning the captured params or `null` if the shape does not match. A `:name`
 * segment captures the URL-decoded request segment; a malformed percent-encoding
 * is treated as a non-match (it will fall through to `notFound`) rather than
 * throwing.
 */
function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const patternSegment = pattern[i] as string;
    const actualSegment = actual[i] as string;
    if (patternSegment.startsWith(":")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(actualSegment);
      } catch {
        return null;
      }
      params[patternSegment.slice(1)] = decoded;
    } else if (patternSegment !== actualSegment) {
      return null;
    }
  }
  return params;
}

/**
 * Resolve `method` + `pathname` against the route table. Path is matched first so
 * that a known path under an unsupported method yields `methodNotAllowed` (with
 * the set of methods that *would* match, for the `Allow` header) rather than a
 * misleading `notFound`. Pure: same inputs, same verdict.
 */
export function matchRoute<H>(
  routes: readonly Route<H>[],
  method: string,
  pathname: string,
): RouteMatch<H> {
  const wanted = method.toUpperCase();
  const actual = toSegments(pathname);
  const allow = new Set<string>();
  for (const route of routes) {
    const params = matchSegments(route.segments, actual);
    if (params === null) {
      continue;
    }
    if (route.method === wanted) {
      return { kind: "matched", handler: route.handler, params };
    }
    allow.add(route.method);
  }
  if (allow.size > 0) {
    return { kind: "methodNotAllowed", allow: [...allow] };
  }
  return { kind: "notFound" };
}
