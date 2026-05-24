import {
  applyEventTypeUpdate,
  DuplicateEventTypeError,
  normalizeNewEventType,
  UnknownEventTypeError,
  type EventType,
  type EventTypeStore,
  type EventTypeUpdate,
  type ListEventTypesOptions,
  type NewEventType,
} from "./event-type.js";

export interface InMemoryEventTypeStoreOptions {
  now?: () => number;
}

export class InMemoryEventTypeStore implements EventTypeStore {
  readonly #now: () => number;
  readonly #byApp = new Map<string, Map<string, EventType>>();

  constructor(options: InMemoryEventTypeStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  async create(input: NewEventType): Promise<EventType> {
    const normalized = normalizeNewEventType(input);
    const nowMs = this.#now();
    let appMap = this.#byApp.get(normalized.appId);
    if (appMap === undefined) {
      appMap = new Map();
      this.#byApp.set(normalized.appId, appMap);
    }
    if (appMap.has(normalized.id)) {
      throw new DuplicateEventTypeError(normalized.appId, normalized.id);
    }
    const et: EventType = {
      id: normalized.id,
      appId: normalized.appId,
      name: normalized.name,
      description: normalized.description,
      schemaExample: normalized.schemaExample,
      archived: false,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    appMap.set(et.id, et);
    return et;
  }

  async get(appId: string, id: string): Promise<EventType | null> {
    return this.#byApp.get(appId)?.get(id) ?? null;
  }

  async list(appId: string, options: ListEventTypesOptions = {}): Promise<readonly EventType[]> {
    const appMap = this.#byApp.get(appId);
    if (appMap === undefined) return [];
    const out: EventType[] = [];
    for (const et of appMap.values()) {
      if (et.archived && options.includeArchived !== true) continue;
      out.push(et);
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  async update(appId: string, id: string, patch: EventTypeUpdate): Promise<EventType> {
    const appMap = this.#byApp.get(appId);
    const current = appMap?.get(id);
    if (current === undefined) {
      throw new UnknownEventTypeError(id);
    }
    const next = applyEventTypeUpdate(current, patch, this.#now());
    appMap!.set(id, next);
    return next;
  }

  async archive(appId: string, id: string): Promise<boolean> {
    const appMap = this.#byApp.get(appId);
    const current = appMap?.get(id);
    if (current === undefined) return false;
    const next: EventType = {
      ...current,
      archived: true,
      updatedAt: this.#now(),
    };
    appMap!.set(id, next);
    return true;
  }
}
