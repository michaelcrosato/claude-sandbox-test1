import { describe, it, expect } from "vitest";
import { isApiErrorCode, errorEnvelope, API_ERROR_CODES } from "./error-codes.js";

describe("error-codes", () => {
  describe("isApiErrorCode", () => {
    it("returns true for all valid API error codes", () => {
      for (const code of API_ERROR_CODES) {
        expect(isApiErrorCode(code)).toBe(true);
      }
    });

    it("returns false for invalid string values", () => {
      expect(isApiErrorCode("unknown_code")).toBe(false);
      expect(isApiErrorCode("INVALID_REQUEST")).toBe(false);
      expect(isApiErrorCode("")).toBe(false);
    });

    it("returns false for non-string values", () => {
      expect(isApiErrorCode(null)).toBe(false);
      expect(isApiErrorCode(undefined)).toBe(false);
      expect(isApiErrorCode(123)).toBe(false);
      expect(isApiErrorCode({})).toBe(false);
      expect(isApiErrorCode([])).toBe(false);
    });
  });

  describe("errorEnvelope", () => {
    it("returns the expected envelope structure", () => {
      const envelope = errorEnvelope("invalid_request", "Missing required field");

      expect(envelope).toEqual({
        error: {
          code: "invalid_request",
          message: "Missing required field",
        },
      });
    });
  });
});
