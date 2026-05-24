import { describe, expect, it } from "vitest";
import {
  DuplicateEventTypeError,
  UnknownEventTypeError,
  type EventTypeStore,
} from "./event-type.js";

export type EventTypeStoreFactory = () => EventTypeStore;

export function describeEventTypeStoreContract(factory: EventTypeStoreFactory): void {
  describe("EventTypeStore contract", () => {
    it("create returns EventType with correct fields", async () => {
      const store = factory();
      const et = await store.create({
        appId: "app1",
        id: "user.created",
        name: "User Created",
        description: "A user was created",
        schemaExample: '{"userId":"123"}',
      });
      expect(et.id).toBe("user.created");
      expect(et.appId).toBe("app1");
      expect(et.name).toBe("User Created");
      expect(et.description).toBe("A user was created");
      expect(et.schemaExample).toBe('{"userId":"123"}');
      expect(et.archived).toBe(false);
      expect(typeof et.createdAt).toBe("number");
      expect(typeof et.updatedAt).toBe("number");
    });

    it("get returns null for unknown id", async () => {
      const store = factory();
      expect(await store.get("app1", "nope")).toBeNull();
    });

    it("get returns null for cross-app id", async () => {
      const store = factory();
      await store.create({ appId: "app1", id: "user.created", name: "User Created" });
      expect(await store.get("app2", "user.created")).toBeNull();
    });

    it("list returns empty for unknown app", async () => {
      const store = factory();
      expect(await store.list("no-such-app")).toEqual([]);
    });

    it("list excludes archived by default, includes when includeArchived: true", async () => {
      const store = factory();
      await store.create({ appId: "app1", id: "user.created", name: "User Created" });
      await store.create({ appId: "app1", id: "user.deleted", name: "User Deleted" });
      await store.archive("app1", "user.deleted");

      const active = await store.list("app1");
      expect(active.map((e) => e.id)).toEqual(["user.created"]);

      const all = await store.list("app1", { includeArchived: true });
      expect(all.map((e) => e.id)).toEqual(["user.created", "user.deleted"]);
    });

    it("list sorts by id ascending", async () => {
      const store = factory();
      await store.create({ appId: "app1", id: "payment.failed", name: "Payment Failed" });
      await store.create({ appId: "app1", id: "user.created", name: "User Created" });
      await store.create({ appId: "app1", id: "order.shipped", name: "Order Shipped" });

      const list = await store.list("app1");
      expect(list.map((e) => e.id)).toEqual([
        "order.shipped",
        "payment.failed",
        "user.created",
      ]);
    });

    it("create throws DuplicateEventTypeError for duplicate id (same appId)", async () => {
      const store = factory();
      await store.create({ appId: "app1", id: "user.created", name: "User Created" });
      await expect(
        store.create({ appId: "app1", id: "user.created", name: "User Created v2" }),
      ).rejects.toThrow(DuplicateEventTypeError);
    });

    it("update returns updated EventType", async () => {
      const store = factory();
      await store.create({
        appId: "app1",
        id: "user.created",
        name: "User Created",
        description: "original",
      });
      const updated = await store.update("app1", "user.created", {
        name: "User Created (updated)",
        description: "new description",
      });
      expect(updated.name).toBe("User Created (updated)");
      expect(updated.description).toBe("new description");
      expect(updated.id).toBe("user.created");
      expect(updated.appId).toBe("app1");
    });

    it("update throws UnknownEventTypeError for unknown id", async () => {
      const store = factory();
      await expect(
        store.update("app1", "nope", { name: "Nope" }),
      ).rejects.toThrow(UnknownEventTypeError);
    });

    it("archive returns true, get returns archived=true", async () => {
      const store = factory();
      await store.create({ appId: "app1", id: "user.created", name: "User Created" });
      const result = await store.archive("app1", "user.created");
      expect(result).toBe(true);
      const et = await store.get("app1", "user.created");
      expect(et?.archived).toBe(true);
    });

    it("archive returns false for unknown id", async () => {
      const store = factory();
      expect(await store.archive("app1", "nope")).toBe(false);
    });

    it("cross-app isolation: create in app1 doesn't appear in app2", async () => {
      const store = factory();
      await store.create({ appId: "app1", id: "user.created", name: "User Created" });
      expect(await store.list("app2")).toEqual([]);
      expect(await store.get("app2", "user.created")).toBeNull();
    });
  });
}
