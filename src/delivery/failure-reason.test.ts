import { describe, expect, it } from "vitest";

import {
  classifyDeliveryFailure,
  DELIVERY_FAILURE_REASONS,
  emptyDeliveryFailureCounts,
  type DeliveryFailureReason,
} from "./failure-reason.js";
import { BlockedUrlError } from "../net/ssrf-guard.js";

/** A Node system error: an Error carrying a string `.code` (+ optional `.syscall`). */
function systemError(code: string, syscall?: string): Error {
  const error = new Error(`${code} something`);
  Object.assign(error, syscall === undefined ? { code } : { code, syscall });
  return error;
}

describe("DELIVERY_FAILURE_REASONS", () => {
  it("has no duplicates and includes the catch-all", () => {
    expect(new Set(DELIVERY_FAILURE_REASONS).size).toBe(DELIVERY_FAILURE_REASONS.length);
    expect(DELIVERY_FAILURE_REASONS).toContain("other");
  });

  it("uses only label-safe lowercase snake_case tokens", () => {
    for (const reason of DELIVERY_FAILURE_REASONS) {
      expect(reason).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("emptyDeliveryFailureCounts", () => {
  it("returns a fresh all-zero tally with every reason present", () => {
    const counts = emptyDeliveryFailureCounts();
    expect(Object.keys(counts).sort()).toEqual([...DELIVERY_FAILURE_REASONS].sort());
    for (const reason of DELIVERY_FAILURE_REASONS) {
      expect(counts[reason]).toBe(0);
    }
  });

  it("returns an independent copy each call (mutation does not leak)", () => {
    const a = emptyDeliveryFailureCounts();
    a.connect_timeout += 5;
    const b = emptyDeliveryFailureCounts();
    expect(b.connect_timeout).toBe(0);
  });
});

describe("classifyDeliveryFailure — HTTP responses", () => {
  const cases: ReadonlyArray<[number, DeliveryFailureReason]> = [
    [400, "http_4xx"],
    [404, "http_4xx"],
    [429, "http_4xx"],
    [499, "http_4xx"],
    [500, "http_5xx"],
    [502, "http_5xx"],
    [599, "http_5xx"],
    [301, "http_other"],
    [302, "http_other"],
    [199, "http_other"],
  ];
  for (const [status, reason] of cases) {
    it(`maps HTTP ${status} → ${reason}`, () => {
      expect(classifyDeliveryFailure({ responseStatus: status })).toBe(reason);
    });
  }

  it("a response status outranks a transport error (we reached the receiver)", () => {
    expect(
      classifyDeliveryFailure({ responseStatus: 503, transportError: systemError("ECONNRESET") }),
    ).toBe("http_5xx");
  });
});

describe("classifyDeliveryFailure — transport errors", () => {
  it("the transport's own connect-deadline message → connect_timeout", () => {
    expect(
      classifyDeliveryFailure({ transportError: new Error("connect timeout after 5000ms") }),
    ).toBe("connect_timeout");
  });

  it("a fetch AbortError (total deadline) → request_timeout", () => {
    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(classifyDeliveryFailure({ transportError: abort })).toBe("request_timeout");
  });

  it("a node:http abort (code ABORT_ERR) → request_timeout", () => {
    expect(classifyDeliveryFailure({ transportError: systemError("ABORT_ERR") })).toBe(
      "request_timeout",
    );
  });

  it("DNS failures (ENOTFOUND / EAI_AGAIN) → dns_failure", () => {
    expect(classifyDeliveryFailure({ transportError: systemError("ENOTFOUND") })).toBe(
      "dns_failure",
    );
    expect(classifyDeliveryFailure({ transportError: systemError("EAI_AGAIN") })).toBe(
      "dns_failure",
    );
  });

  it("ECONNREFUSED → connection_refused", () => {
    expect(classifyDeliveryFailure({ transportError: systemError("ECONNREFUSED") })).toBe(
      "connection_refused",
    );
  });

  it("ECONNRESET / EPIPE / ECONNABORTED → connection_reset", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ECONNABORTED"]) {
      expect(classifyDeliveryFailure({ transportError: systemError(code) })).toBe(
        "connection_reset",
      );
    }
  });

  it("ETIMEDOUT distinguishes a connect-phase syscall from a later one", () => {
    expect(
      classifyDeliveryFailure({ transportError: systemError("ETIMEDOUT", "connect") }),
    ).toBe("connect_timeout");
    expect(classifyDeliveryFailure({ transportError: systemError("ETIMEDOUT", "read") })).toBe(
      "request_timeout",
    );
  });

  it("TLS / certificate errors → tls_error", () => {
    for (const code of [
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ]) {
      expect(classifyDeliveryFailure({ transportError: systemError(code) })).toBe("tls_error");
    }
  });

  it("a BlockedUrlError from the SSRF guard → ssrf_blocked", () => {
    const blocked = new BlockedUrlError("resolves to 10.0.0.5", "blocked_resolved_address");
    expect(classifyDeliveryFailure({ transportError: blocked })).toBe("ssrf_blocked");
  });

  it("a BlockedUrlError for an empty DNS result → dns_failure (it is really a DNS miss)", () => {
    const empty = new BlockedUrlError("no addresses", "dns_no_address");
    expect(classifyDeliveryFailure({ transportError: empty })).toBe("dns_failure");
  });

  it("an unrecognized transport error → other", () => {
    expect(classifyDeliveryFailure({ transportError: new Error("kaboom") })).toBe("other");
    expect(classifyDeliveryFailure({ transportError: "a bare string" })).toBe("other");
    expect(classifyDeliveryFailure({ transportError: systemError("ESOMETHINGNEW") })).toBe(
      "other",
    );
  });
});

describe("classifyDeliveryFailure — pre-flight and priority", () => {
  it("maps each pre-flight discriminant straight through", () => {
    expect(classifyDeliveryFailure({ preflight: "expired" })).toBe("expired");
    expect(classifyDeliveryFailure({ preflight: "no_endpoint" })).toBe("no_endpoint");
    expect(classifyDeliveryFailure({ preflight: "other" })).toBe("other");
  });

  it("an empty signal classifies as other", () => {
    expect(classifyDeliveryFailure({})).toBe("other");
    expect(classifyDeliveryFailure({ responseStatus: null, transportError: null, preflight: null })).toBe(
      "other",
    );
  });

  it("a transport error outranks a pre-flight discriminant", () => {
    expect(
      classifyDeliveryFailure({
        transportError: systemError("ECONNREFUSED"),
        preflight: "no_endpoint",
      }),
    ).toBe("connection_refused");
  });
});
