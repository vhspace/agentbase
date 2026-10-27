export function log(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry = {
    level,
    message,
    service: "agentbase-mcp",
    timestamp: new Date().toISOString(),
    ...data,
  };
  if (level === "ERROR") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}
