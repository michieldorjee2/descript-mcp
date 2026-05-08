type LogLevel = "info" | "warn" | "error" | "debug";

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  request_id?: string;
  [key: string]: unknown;
}

function log(
  level: LogLevel,
  msg: string,
  data?: Record<string, unknown>,
  requestId?: string
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(requestId ? { request_id: requestId } : {}),
    ...data,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>, requestId?: string) =>
    log("info", msg, data, requestId),
  warn: (msg: string, data?: Record<string, unknown>, requestId?: string) =>
    log("warn", msg, data, requestId),
  error: (msg: string, data?: Record<string, unknown>, requestId?: string) =>
    log("error", msg, data, requestId),
  debug: (msg: string, data?: Record<string, unknown>, requestId?: string) =>
    log("debug", msg, data, requestId),
};
