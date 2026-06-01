import { describe, it, expect } from "vitest";
import { normalizeNewEventType, applyEventTypeUpdate, DuplicateEventTypeError, UnknownEventTypeError } from "./event-type.js";

describe("event-type", () => {
  describe("normalizeNewEventType", () => {
    it("throws if appId is missing, empty, or not a string", () => {
      expect(() => normalizeNewEventType({ id: "my-id", name: "My Event" } as any)).toThrow(TypeError);
      expect(() => normalizeNewEventType({ appId: "", id: "my-id", name: "My Event" } as any)).toThrow(TypeError);
      expect(() => normalizeNewEventType({ appId: 123, id: "my-id", name: "My Event" } as any)).toThrow(TypeError);
    });

    it("throws if id is missing, empty, or not a string", () => {
      expect(() => normalizeNewEventType({ appId: "app-1", name: "My Event" } as any)).toThrow(TypeError);
      expect(() => normalizeNewEventType({ appId: "app-1", id: "", name: "My Event" } as any)).toThrow(TypeError);
    });

    it("throws if id is longer than 100 characters", () => {
      const longId = "a".repeat(101);
      expect(() => normalizeNewEventType({ appId: "app-1", id: longId, name: "My Event" })).toThrow(TypeError);
    });

    it("throws if id contains invalid characters", () => {
      expect(() => normalizeNewEventType({ appId: "app-1", id: "my id", name: "My Event" })).toThrow(TypeError);
      expect(() => normalizeNewEventType({ appId: "app-1", id: "-my-id", name: "My Event" })).toThrow(TypeError);
      expect(() => normalizeNewEventType({ appId: "app-1", id: "my-id!", name: "My Event" })).toThrow(TypeError);
    });

    it("accepts valid ids", () => {
      const input = { appId: "app-1", id: "my.valid_id-123", name: "My Event" };
      const normalized = normalizeNewEventType(input);
      expect(normalized.id).toBe("my.valid_id-123");
    });

    it("throws if name is missing, empty, or not a string", () => {
      expect(() => normalizeNewEventType({ appId: "app-1", id: "my-id" } as any)).toThrow(TypeError);
      expect(() => normalizeNewEventType({ appId: "app-1", id: "my-id", name: "" } as any)).toThrow(TypeError);
      expect(() => normalizeNewEventType({ appId: "app-1", id: "my-id", name: "   " } as any)).toThrow(TypeError);
    });

    it("throws if name is longer than 200 characters", () => {
      const longName = "a".repeat(201);
      expect(() => normalizeNewEventType({ appId: "app-1", id: "my-id", name: longName })).toThrow(TypeError);
    });

    it("trims whitespace from name", () => {
      const input = { appId: "app-1", id: "my-id", name: "  My Event  " };
      const normalized = normalizeNewEventType(input);
      expect(normalized.name).toBe("My Event");
    });

    it("handles description correctly", () => {
      expect(normalizeNewEventType({ appId: "app-1", id: "my-id", name: "My Event" }).description).toBeNull();
      expect(normalizeNewEventType({ appId: "app-1", id: "my-id", name: "My Event", description: null }).description).toBeNull();
      expect(normalizeNewEventType({ appId: "app-1", id: "my-id", name: "My Event", description: "My description" }).description).toBe("My description");
    });

    it("throws if description is not a string or too long", () => {
      expect(() => normalizeNewEventType({ appId: "app-1", id: "my-id", name: "My Event", description: 123 as any })).toThrow(TypeError);
      const longDesc = "a".repeat(1001);
      expect(() => normalizeNewEventType({ appId: "app-1", id: "my-id", name: "My Event", description: longDesc })).toThrow(TypeError);
    });

    it("handles schemaExample correctly", () => {
      expect(normalizeNewEventType({ appId: "app-1", id: "my-id", name: "My Event" }).schemaExample).toBeNull();
      expect(normalizeNewEventType({ appId: "app-1", id: "my-id", name: "My Event", schemaExample: null }).schemaExample).toBeNull();
      expect(normalizeNewEventType({ appId: "app-1", id: "my-id", name: "My Event", schemaExample: '{"foo":"bar"}' }).schemaExample).toBe('{"foo":"bar"}');
    });

    it("throws if schemaExample is not a string or invalid JSON", () => {
      expect(() => normalizeNewEventType({ appId: "app-1", id: "my-id", name: "My Event", schemaExample: 123 as any })).toThrow(TypeError);
      expect(() => normalizeNewEventType({ appId: "app-1", id: "my-id", name: "My Event", schemaExample: 'invalid json' })).toThrow(TypeError);
    });
  });

  describe("applyEventTypeUpdate", () => {
    const current = {
      id: "my-id",
      appId: "app-1",
      name: "Old Name",
      description: "Old description",
      schemaExample: '{"old":"schema"}',
      archived: false,
      createdAt: 1000,
      updatedAt: 1000,
    };

    it("updates only provided fields", () => {
      const updated = applyEventTypeUpdate(current, { name: "New Name" }, 2000);
      expect(updated.name).toBe("New Name");
      expect(updated.description).toBe("Old description");
      expect(updated.updatedAt).toBe(2000);
    });

    it("allows setting description and schemaExample to null", () => {
      const updated = applyEventTypeUpdate(current, { description: null, schemaExample: null }, 2000);
      expect(updated.description).toBeNull();
      expect(updated.schemaExample).toBeNull();
    });

    it("validates updated fields", () => {
      expect(() => applyEventTypeUpdate(current, { name: "" }, 2000)).toThrow(TypeError);
      expect(() => applyEventTypeUpdate(current, { description: "a".repeat(1001) }, 2000)).toThrow(TypeError);
      expect(() => applyEventTypeUpdate(current, { schemaExample: "invalid json" }, 2000)).toThrow(TypeError);
    });
  });

  describe("Errors", () => {
    it("DuplicateEventTypeError sets properties correctly", () => {
      const error = new DuplicateEventTypeError("app-1", "my-id");
      expect(error.message).toBe('event type "my-id" already exists in app "app-1"');
      expect(error.name).toBe("DuplicateEventTypeError");
      expect(error.appId).toBe("app-1");
      expect(error.eventTypeId).toBe("my-id");
    });

    it("UnknownEventTypeError sets properties correctly", () => {
      const error = new UnknownEventTypeError("my-id");
      expect(error.message).toBe('no event type with id "my-id"');
      expect(error.name).toBe("UnknownEventTypeError");
      expect(error.eventTypeId).toBe("my-id");
    });
  });
});
