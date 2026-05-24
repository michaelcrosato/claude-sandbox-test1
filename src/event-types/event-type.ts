export class DuplicateEventTypeError extends Error {
  readonly eventTypeId: string;
  readonly appId: string;
  constructor(appId: string, id: string) {
    super(`event type "${id}" already exists in app "${appId}"`);
    this.name = "DuplicateEventTypeError";
    this.eventTypeId = id;
    this.appId = appId;
  }
}

export class UnknownEventTypeError extends Error {
  readonly eventTypeId: string;
  constructor(id: string) {
    super(`no event type with id "${id}"`);
    this.name = "UnknownEventTypeError";
    this.eventTypeId = id;
  }
}

export interface EventType {
  readonly id: string;
  readonly appId: string;
  readonly name: string;
  readonly description: string | null;
  readonly schemaExample: string | null;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewEventType {
  readonly appId: string;
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly schemaExample?: string | null;
}

export interface EventTypeUpdate {
  readonly name?: string;
  readonly description?: string | null;
  readonly schemaExample?: string | null;
}

export interface ListEventTypesOptions {
  readonly includeArchived?: boolean;
}

export interface EventTypeStore {
  create(input: NewEventType): Promise<EventType>;
  get(appId: string, id: string): Promise<EventType | null>;
  list(appId: string, options?: ListEventTypesOptions): Promise<readonly EventType[]>;
  update(appId: string, id: string, patch: EventTypeUpdate): Promise<EventType>;
  archive(appId: string, id: string): Promise<boolean>;
}

const EVENT_TYPE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function normalizeEventTypeId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("event type id must be a non-empty string");
  }
  if (id.length > 100) {
    throw new TypeError("event type id must be at most 100 characters");
  }
  if (!EVENT_TYPE_ID_PATTERN.test(id)) {
    throw new TypeError(
      "event type id must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens",
    );
  }
  return id;
}

function normalizeName(name: unknown): string {
  if (typeof name !== "string") {
    throw new TypeError("event type name must be a string");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new TypeError("event type name must be a non-empty string");
  }
  if (trimmed.length > 200) {
    throw new TypeError("event type name must be at most 200 characters");
  }
  return trimmed;
}

function normalizeDescription(description: unknown): string | null {
  if (description === undefined || description === null) {
    return null;
  }
  if (typeof description !== "string") {
    throw new TypeError("event type description must be a string or null");
  }
  if (description.length > 1000) {
    throw new TypeError("event type description must be at most 1000 characters");
  }
  return description;
}

function normalizeSchemaExample(schemaExample: unknown): string | null {
  if (schemaExample === undefined || schemaExample === null) {
    return null;
  }
  if (typeof schemaExample !== "string") {
    throw new TypeError("event type schemaExample must be a JSON string or null");
  }
  try {
    JSON.parse(schemaExample);
  } catch {
    throw new TypeError("event type schemaExample must be valid JSON");
  }
  return schemaExample;
}

export interface NormalizedNewEventType {
  readonly appId: string;
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly schemaExample: string | null;
}

export function normalizeNewEventType(input: NewEventType): NormalizedNewEventType {
  if (typeof input.appId !== "string" || input.appId.length === 0) {
    throw new TypeError("appId must be a non-empty string");
  }
  return {
    appId: input.appId,
    id: normalizeEventTypeId(input.id),
    name: normalizeName(input.name),
    description: "description" in input ? normalizeDescription(input.description) : null,
    schemaExample: "schemaExample" in input ? normalizeSchemaExample(input.schemaExample) : null,
  };
}

export function applyEventTypeUpdate(
  current: EventType,
  patch: EventTypeUpdate,
  nowMs: number,
): EventType {
  return {
    id: current.id,
    appId: current.appId,
    name: "name" in patch ? normalizeName(patch.name) : current.name,
    description:
      "description" in patch ? normalizeDescription(patch.description) : current.description,
    schemaExample:
      "schemaExample" in patch
        ? normalizeSchemaExample(patch.schemaExample)
        : current.schemaExample,
    archived: current.archived,
    createdAt: current.createdAt,
    updatedAt: nowMs,
  };
}
