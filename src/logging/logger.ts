/**
 * Structured operational logging — the runtime-visibility seam the gateway was
 * missing.
 *
 * Until now Posthorn was a black box at runtime: the HTTP server's 500 fallback
 * *silently swallowed* the underlying error, the delivery worker / fan-out
 * dispatcher / pruner `onError` seams were left unwired (so a backend hiccup, a
 * failed audit write, or a system-event emit failure vanished), and there was no
 * access log at all. Operators had Prometheus counters but no line to grep. Every
 * serious webhook platform ships structured logs; this module is Posthorn's.
 *
 * Faithful to the codebase's pure-core / thin-I/O discipline (the HTTP handler, the
 * delivery worker, `loadConfig`): a {@link Logger} makes the *decision* of whether
 * an entry clears the configured level and what fields it carries — all pure and
 * deterministic against an injected {@link LogSink} and clock — while the only I/O
 * is the default sink writing a JSON line to stdout. It carries **zero runtime
 * dependencies** (the single-container, no-deps wedge): JSON Lines over
 * `process.stdout`, the format every log collector (Loki, CloudWatch, Datadog, …)
 * ingests without configuration.
 *
 * A library embedder who wants their own logging substitutes a {@link LogSink}
 * (route structured entries to pino/winston/OpenTelemetry) or silences output
 * entirely with {@link SILENT_LOGGER} / `level: "silent"`.
 */

/** Emitted severity levels, in ascending order of importance. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * A configured minimum level: one of the {@link LogLevel}s, or `"silent"` to
 * suppress all output. An entry is emitted only when its level is at or above the
 * configured threshold (`silent` is above every level, so nothing clears it).
 */
export type LogThreshold = LogLevel | "silent";

/** Structured context attached to a log entry (`{ status: 500, durationMs: 12 }`). */
export type LogFields = Record<string, unknown>;

/** Numeric severity ranking; a higher number is more important. */
const ORDER: Record<LogThreshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** The default minimum level when `POSTHORN_LOG_LEVEL` is unset. */
export const DEFAULT_LOG_LEVEL: LogThreshold = "info";

/** Every accepted {@link LogThreshold} value, for config validation + docs. */
export const LOG_LEVELS: readonly LogThreshold[] = [
  "debug",
  "info",
  "warn",
  "error",
  "silent",
];

/** Whether `value` is a recognized {@link LogThreshold} (used by config parsing). */
export function isLogThreshold(value: string): value is LogThreshold {
  return value in ORDER;
}

/**
 * A fully-resolved log entry — the merged, immutable record handed to a
 * {@link LogSink}. `fields` already combines any bound (child) context with the
 * per-call fields. Tests inject a sink and assert directly on these objects, so the
 * logger's decisions are verifiable without parsing serialized output.
 */
export interface LogEntry {
  /** ISO-8601 timestamp (UTC) of when the entry was created. */
  readonly time: string;
  /** The entry's severity. */
  readonly level: LogLevel;
  /** Human-readable message. */
  readonly msg: string;
  /** Structured context (bound child fields merged with per-call fields). */
  readonly fields: LogFields;
}

/** Consumes a finished {@link LogEntry}. Injectable; the default writes JSON to stdout. */
export type LogSink = (entry: LogEntry) => void;

/**
 * The logging interface the rest of the gateway depends on. Four severity methods
 * plus {@link Logger.child} for binding context (`logger.child({ component:
 * "worker" })`) onto every subsequent entry.
 */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /**
   * Return a logger that merges `bound` into every entry's `fields` (per-call
   * fields win on a key collision). Shares this logger's sink, clock, and level.
   */
  child(bound: LogFields): Logger;
}

/**
 * Serialize a {@link LogEntry} to a single-line JSON string (no trailing newline).
 * Pure and total: it never throws.
 *
 *  - Reserved keys (`time`/`level`/`msg`) are written first and cannot be clobbered
 *    by a same-named field, keeping the on-disk schema stable.
 *  - `Error` values (the common `{ err }` field) serialize to `{ name, message,
 *    stack }` — a plain `JSON.stringify(error)` yields `{}` because Error's own
 *    properties are non-enumerable, which would discard the very diagnostics the
 *    log exists to capture.
 *  - `bigint` becomes its decimal string (`JSON.stringify` throws on it otherwise).
 *  - A circular or otherwise unserializable `fields` object falls back to a
 *    well-formed entry carrying a `fields_error` marker rather than throwing and
 *    losing the line.
 */
export function formatJsonLine(entry: LogEntry): string {
  const record: Record<string, unknown> = {
    time: entry.time,
    level: entry.level,
    msg: entry.msg,
  };
  for (const [key, value] of Object.entries(entry.fields)) {
    if (key !== "time" && key !== "level" && key !== "msg") {
      record[key] = value;
    }
  }
  const replacer = (_key: string, value: unknown): unknown => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(value.stack !== undefined ? { stack: value.stack } : {}),
      };
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
  try {
    return JSON.stringify(record, replacer);
  } catch {
    // A circular reference (or other JSON.stringify failure) in the caller's
    // fields must never lose the line; emit a well-formed entry noting the problem.
    return JSON.stringify({
      time: entry.time,
      level: entry.level,
      msg: entry.msg,
      fields_error: "unserializable log fields",
    });
  }
}

/** The default sink: one JSON line per entry to stdout (12-factor structured logs). */
export const jsonStdoutSink: LogSink = (entry) => {
  process.stdout.write(`${formatJsonLine(entry)}\n`);
};

/** Construction options for {@link createLogger}. */
export interface LoggerOptions {
  /** Minimum level to emit. Defaults to {@link DEFAULT_LOG_LEVEL} (`"info"`). */
  readonly level?: LogThreshold;
  /** Where emitted entries go. Defaults to {@link jsonStdoutSink}. */
  readonly sink?: LogSink;
  /** Clock for the entry timestamp (epoch ms). Defaults to {@link Date.now}. */
  readonly now?: () => number;
  /** Fields bound onto every entry (the basis for {@link Logger.child}). */
  readonly base?: LogFields;
}

/**
 * Build a {@link Logger}. With no options it emits `info`-and-above as JSON lines to
 * stdout using the wall clock. Inject `sink`/`now` for deterministic tests, `level`
 * to control verbosity (`"silent"` suppresses everything), and `base` to bind
 * standing context.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = options.level ?? DEFAULT_LOG_LEVEL;
  const sink = options.sink ?? jsonStdoutSink;
  const now = options.now ?? Date.now;
  const base = options.base;
  const minRank = ORDER[threshold];

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (ORDER[level] < minRank) {
      return;
    }
    const merged: LogFields =
      base !== undefined
        ? fields !== undefined
          ? { ...base, ...fields }
          : { ...base }
        : fields !== undefined
          ? { ...fields }
          : {};
    sink({
      time: new Date(now()).toISOString(),
      level,
      msg,
      fields: merged,
    });
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (bound) =>
      createLogger({
        level: threshold,
        sink,
        now,
        base: base !== undefined ? { ...base, ...bound } : { ...bound },
      }),
  };
}

/**
 * A logger that discards everything (and whose {@link Logger.child} returns itself).
 * The zero-overhead default for callers — `createHttpServer`, library embedders —
 * that have not opted into logging, so existing behavior is unchanged unless a
 * logger is explicitly supplied.
 */
export const SILENT_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => SILENT_LOGGER,
};
