export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const EVENT_TYPE_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;

export function isValidEventTypeIdentifier(value: string): boolean {
  return EVENT_TYPE_PATTERN.test(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;

    const currentValue = current.value;
    if (currentValue === null || typeof currentValue === 'string' || typeof currentValue === 'boolean') {
      continue;
    }
    if (typeof currentValue === 'number') {
      if (!Number.isFinite(currentValue)) return false;
      continue;
    }
    if (Array.isArray(currentValue)) {
      for (const child of currentValue) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof currentValue === 'object') {
      for (const child of Object.values(currentValue)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }

    return false;
  }

  return true;
}

export function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }

  return false;
}
