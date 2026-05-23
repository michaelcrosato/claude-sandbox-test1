import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, type OpenApiDocument } from "./openapi.js";
import { API_ROUTE_KEYS, patternToOpenApiPath } from "./api.js";
import { POSTHORN_VERSION } from "../version.js";

/** HTTP method keys an OpenAPI path item may carry (others, e.g. `parameters`, are not operations). */
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

/** The set of `"METHOD /open/api/path"` operations the document actually documents. */
function documentedOperations(doc: OpenApiDocument): Set<string> {
  const ops = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method)) {
        ops.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return ops;
}

/** The set of operations the router actually serves, in OpenAPI path-template form. */
function routerOperations(): Set<string> {
  return new Set(
    API_ROUTE_KEYS.map((key) => {
      const sep = key.indexOf(" ");
      const method = key.slice(0, sep);
      const pattern = key.slice(sep + 1);
      return `${method} ${patternToOpenApiPath(pattern)}`;
    }),
  );
}

/** Walk the document, collecting every `$ref` string. */
function collectRefs(node: unknown, acc: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectRefs(child, acc);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        acc.push(value);
      } else {
        collectRefs(value, acc);
      }
    }
  }
}

/** Every operation object in the document, paired with its `"METHOD path"` key. */
function eachOperation(
  doc: OpenApiDocument,
): { key: string; op: Record<string, unknown> }[] {
  const out: { key: string; op: Record<string, unknown> }[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (HTTP_METHODS.has(method)) {
        out.push({ key: `${method.toUpperCase()} ${path}`, op: op as Record<string, unknown> });
      }
    }
  }
  return out;
}

describe("buildOpenApiDocument — structure", () => {
  it("is an OpenAPI 3.1 document naming the running build", () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Posthorn");
    expect(doc.info.version).toBe(POSTHORN_VERSION);
    expect(doc.info.version.length).toBeGreaterThan(0);
    expect(doc.info.license.identifier).toBe("MIT");
  });

  it("declares a global Bearer security requirement with a matching scheme", () => {
    const doc = buildOpenApiDocument();
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    const scheme = doc.components.securitySchemes["bearerAuth"] as Record<string, unknown>;
    expect(scheme.type).toBe("http");
    expect(scheme.scheme).toBe("bearer");
  });

  it("returns a fresh object each call (no shared mutable singleton)", () => {
    expect(buildOpenApiDocument()).not.toBe(buildOpenApiDocument());
    expect(buildOpenApiDocument()).toEqual(buildOpenApiDocument());
  });

  it("gives every operation a unique operationId, a summary, and described responses", () => {
    const doc = buildOpenApiDocument();
    const ids = new Set<string>();
    for (const { key, op } of eachOperation(doc)) {
      expect(typeof op.operationId, `${key} operationId`).toBe("string");
      expect(ids.has(op.operationId as string), `${key} duplicate operationId`).toBe(false);
      ids.add(op.operationId as string);
      expect(typeof op.summary, `${key} summary`).toBe("string");
      const responses = op.responses as Record<string, { description?: unknown }>;
      expect(Object.keys(responses).length, `${key} responses`).toBeGreaterThan(0);
      for (const [status, response] of Object.entries(responses)) {
        expect(typeof response.description, `${key} ${status} description`).toBe("string");
      }
    }
  });

  it("gates every admin route with the `adminAuth` scheme (never the tenant bearer)", () => {
    const doc = buildOpenApiDocument();
    const adminScheme = doc.components.securitySchemes["adminAuth"] as Record<string, unknown>;
    expect(adminScheme.type).toBe("http");
    expect(adminScheme.scheme).toBe("bearer");
    const adminOps = eachOperation(doc).filter(({ key }) => key.includes(" /v1/admin/"));
    // All nine control-plane operations are documented…
    expect(adminOps.length).toBe(9);
    // …and each requires adminAuth (not the global bearerAuth, and not `security: []`).
    for (const { key, op } of adminOps) {
      expect(op.security, `${key} security`).toEqual([{ adminAuth: [] }]);
    }
  });

  it("marks exactly the three unauthenticated routes with `security: []`", () => {
    const doc = buildOpenApiDocument();
    const open = new Set<string>();
    for (const { key, op } of eachOperation(doc)) {
      if (Array.isArray(op.security) && op.security.length === 0) {
        open.add(key);
      }
    }
    expect(open).toEqual(new Set(["GET /healthz", "GET /metrics", "GET /openapi.json"]));
  });
});

describe("buildOpenApiDocument — drift guard against the real router", () => {
  it("documents exactly the operations the router serves (both directions)", () => {
    const documented = documentedOperations(buildOpenApiDocument());
    const served = routerOperations();
    // An assertion in each direction so the failure message names whichever side is out
    // of sync: a route added without a doc entry, or a doc entry without a route.
    expect([...documented].sort(), "documented but not routed").toEqual([...served].sort());
  });
});

describe("buildOpenApiDocument — reference integrity", () => {
  it("resolves every $ref to a defined component schema", () => {
    const doc = buildOpenApiDocument();
    const refs: string[] = [];
    collectRefs(doc.paths, refs);
    collectRefs(doc.components.schemas, refs);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect(r.startsWith("#/components/schemas/"), `ref shape: ${r}`).toBe(true);
      const name = r.slice("#/components/schemas/".length);
      expect(doc.components.schemas[name], `unresolved ref: ${r}`).toBeDefined();
    }
  });

  it("has no orphan schemas (every defined schema is referenced)", () => {
    const doc = buildOpenApiDocument();
    const refs: string[] = [];
    collectRefs(doc, refs);
    const referenced = new Set(refs.map((r) => r.slice("#/components/schemas/".length)));
    for (const name of Object.keys(doc.components.schemas)) {
      expect(referenced.has(name), `orphan schema: ${name}`).toBe(true);
    }
  });
});

describe("patternToOpenApiPath", () => {
  it("converts `:param` segments to `{param}` and leaves static paths intact", () => {
    expect(patternToOpenApiPath("/healthz")).toBe("/healthz");
    expect(patternToOpenApiPath("/v1/messages/:id")).toBe("/v1/messages/{id}");
    expect(patternToOpenApiPath("/v1/messages/:id/retry")).toBe("/v1/messages/{id}/retry");
  });
});
