import { describe, expect, it } from "vitest";

import {
  createLogger,
  formatJsonLine,
  isLogThreshold,
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  SILENT_LOGGER,
  type LogEntry,
  type LogLevel,
} from "./logger.js";

/** An array-backed sink plus the array it fills — the seam tests assert on. */
function collectingLogger(): { entries: LogEntry[]; sink: (e: LogEntry) => void } {
  const entries: LogEntry[] = [];
  return { entries, sink: (e: LogEntry) => entries.push(e) };
}

const FIXED_NOW = () => 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

describe("createLogger — level filtering", () => {
  it("emits an entry at or above the threshold and drops anything below", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ level: "warn", sink, now: FIXED_NOW });

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(entries.map((x) => x.level)).toEqual(["warn", "error"]);
  });

  it("defaults to info when no level is given", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ sink, now: FIXED_NOW });
    log.debug("nope");
    log.info("yes");
    expect(entries.map((x) => x.msg)).toEqual(["yes"]);
    expect(DEFAULT_LOG_LEVEL).toBe("info");
  });

  it("silent suppresses every level", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ level: "silent", sink, now: FIXED_NOW });
    for (const level of ["debug", "info", "warn", "error"] as const) {
      log[level]("x");
    }
    expect(entries).toEqual([]);
  });

  it("debug emits everything", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ level: "debug", sink, now: FIXED_NOW });
    log.debug("a");
    log.info("b");
    expect(entries).toHaveLength(2);
  });
});

describe("createLogger — entry shape", () => {
  it("stamps an ISO time, the level, the message, and the fields", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ level: "debug", sink, now: FIXED_NOW });
    log.info("hello", { a: 1, b: "two" });
    expect(entries[0]).toEqual({
      time: "2023-11-14T22:13:20.000Z",
      level: "info",
      msg: "hello",
      fields: { a: 1, b: "two" },
    });
  });

  it("uses an empty fields object when none is supplied", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ level: "debug", sink, now: FIXED_NOW });
    log.info("bare");
    expect(entries[0]!.fields).toEqual({});
  });

  it("does not share field references between entries", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ level: "debug", sink, now: FIXED_NOW });
    log.info("one", { n: 1 });
    log.info("two", { n: 2 });
    expect(entries[0]!.fields).not.toBe(entries[1]!.fields);
    expect(entries[0]!.fields).toEqual({ n: 1 });
  });
});

describe("createLogger — child binding", () => {
  it("merges bound fields into every entry", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ level: "debug", sink, now: FIXED_NOW }).child({
      component: "worker",
    });
    log.info("tick", { count: 3 });
    expect(entries[0]!.fields).toEqual({ component: "worker", count: 3 });
  });

  it("lets per-call fields override a bound key", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ level: "debug", sink, now: FIXED_NOW }).child({ component: "a" });
    log.info("m", { component: "b" });
    expect(entries[0]!.fields.component).toBe("b");
  });

  it("nests: a child of a child merges both bound sets", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ level: "debug", sink, now: FIXED_NOW })
      .child({ component: "http" })
      .child({ requestId: "r1" });
    log.info("req");
    expect(entries[0]!.fields).toEqual({ component: "http", requestId: "r1" });
  });

  it("inherits the parent threshold (a child cannot emit below it)", () => {
    const { entries, sink } = collectingLogger();
    const log = createLogger({ level: "warn", sink, now: FIXED_NOW }).child({ c: 1 });
    log.info("dropped");
    log.error("kept");
    expect(entries.map((x) => x.msg)).toEqual(["kept"]);
  });
});

describe("formatJsonLine", () => {
  const entry = (level: LogLevel, msg: string, fields: Record<string, unknown>): LogEntry => ({
    time: "2023-11-14T22:13:20.000Z",
    level,
    msg,
    fields,
  });

  it("produces a single-line JSON object with reserved keys first", () => {
    const line = formatJsonLine(entry("info", "hi", { a: 1 }));
    expect(line).toBe('{"time":"2023-11-14T22:13:20.000Z","level":"info","msg":"hi","a":1}');
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toMatchObject({ level: "info", msg: "hi", a: 1 });
  });

  it("reserved keys cannot be clobbered by a same-named field", () => {
    const parsed = JSON.parse(
      formatJsonLine(entry("error", "real", { level: "fake", msg: "fake", time: "fake" })),
    );
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("real");
    expect(parsed.time).toBe("2023-11-14T22:13:20.000Z");
  });

  it("serializes an Error to name/message/stack (not the empty object JSON gives)", () => {
    const err = new TypeError("boom");
    const parsed = JSON.parse(formatJsonLine(entry("error", "failed", { err })));
    expect(parsed.err.name).toBe("TypeError");
    expect(parsed.err.message).toBe("boom");
    expect(typeof parsed.err.stack).toBe("string");
  });

  it("serializes a nested Error too", () => {
    const parsed = JSON.parse(
      formatJsonLine(entry("error", "x", { detail: { cause: new Error("inner") } })),
    );
    expect(parsed.detail.cause.message).toBe("inner");
  });

  it("stringifies a bigint rather than throwing", () => {
    const parsed = JSON.parse(formatJsonLine(entry("info", "big", { n: 10n })));
    expect(parsed.n).toBe("10");
  });

  it("falls back to a well-formed line on a circular structure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const line = formatJsonLine(entry("warn", "loop", { circular }));
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toBe("loop");
    expect(parsed.fields_error).toBe("unserializable log fields");
  });
});

describe("SILENT_LOGGER", () => {
  it("discards everything and returns itself from child", () => {
    expect(() => {
      SILENT_LOGGER.debug("a");
      SILENT_LOGGER.info("b", { x: 1 });
      SILENT_LOGGER.warn("c");
      SILENT_LOGGER.error("d", { err: new Error("ignored") });
    }).not.toThrow();
    expect(SILENT_LOGGER.child({ a: 1 })).toBe(SILENT_LOGGER);
  });
});

describe("isLogThreshold / LOG_LEVELS", () => {
  it("accepts the five valid thresholds", () => {
    for (const level of ["debug", "info", "warn", "error", "silent"]) {
      expect(isLogThreshold(level)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const bad of ["", "verbose", "trace", "INFO", "fatal"]) {
      expect(isLogThreshold(bad)).toBe(false);
    }
  });

  it("LOG_LEVELS lists exactly the accepted values", () => {
    expect([...LOG_LEVELS].sort()).toEqual(["debug", "error", "info", "silent", "warn"]);
  });
});
