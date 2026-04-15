import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import middy from "@middy/core";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";

export { MetricUnit };

export const logger = new Logger({
  serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? "agentbase",
  logLevel: (process.env.LOG_LEVEL as "INFO" | "DEBUG" | "WARN" | "ERROR") ?? "INFO",
});

export const metrics = new Metrics({
  namespace: "AgentBase",
  serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? "agentbase",
});

export const tracer = new Tracer({
  serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? "agentbase",
});

export function createMiddyHandler<TEvent, TResult>(
  handler: (event: TEvent) => Promise<TResult>,
) {
  return middy(handler)
    .use(injectLambdaContext(logger, { clearState: true }))
    .use(logMetrics(metrics, { captureColdStartMetric: true }))
    .use(captureLambdaHandler(tracer));
}
