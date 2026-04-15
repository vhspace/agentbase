import { api } from "./api";
import { cdn } from "./cdn";
import { mcpFn, mcpCdn } from "./mcp";
import { table } from "./database";

const REGION = "us-east-1";

export const dashboard: aws.cloudwatch.Dashboard = new aws.cloudwatch.Dashboard("AgentbaseDashboard", {
  dashboardName: `agentbase-${$app.stage}`,
  dashboardBody: $resolve([
    api.nodes.api.id,
    mcpFn.name,
    cdn.id,
    mcpCdn.id,
    table.name,
  ]).apply(([apiId, mcpFnName, cdnId, mcpCdnId, tableName]) =>
    JSON.stringify({
      widgets: [
        // ── Row 0: Business Metrics ─────────────────────────────────────
        {
          type: "text",
          x: 0, y: 0, width: 24, height: 1,
          properties: { markdown: "## Business Metrics" },
        },
        {
          type: "metric",
          x: 0, y: 1, width: 8, height: 6,
          properties: {
            title: "Signups",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 3600,
            stat: "Sum",
            metrics: [
              ["AgentBase", "UserSignup", { label: "New Signups", color: "#4CAF50" }],
              ["AgentBase", "ColdStart", { label: "Cold Starts", color: "#9C27B0", yAxis: "right" }],
            ],
          },
        },
        {
          type: "metric",
          x: 8, y: 1, width: 8, height: 6,
          properties: {
            title: "Knowledge Operations",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 3600,
            stat: "Sum",
            metrics: [
              ["AgentBase", "KnowledgeCreate", { label: "Creates", color: "#2196F3" }],
              ["AgentBase", "KnowledgeDelete", { label: "Deletes", color: "#F44336" }],
            ],
          },
        },
        {
          type: "metric",
          x: 16, y: 1, width: 8, height: 6,
          properties: {
            title: "Searches",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 3600,
            metrics: [
              ["AgentBase", "KnowledgeSearch", { stat: "Sum", label: "Total Searches", color: "#FF9800" }],
              ["AgentBase", "SearchResultCount", { stat: "Average", label: "Avg Results / Search", color: "#2196F3", yAxis: "right" }],
            ],
          },
        },

        // ── Row 1: AppSync ───────────────────────────────────────────────
        {
          type: "text",
          x: 0, y: 8, width: 24, height: 1,
          properties: { markdown: "## AppSync GraphQL API" },
        },
        {
          type: "metric",
          x: 0, y: 9, width: 8, height: 6,
          properties: {
            title: "Request Volume",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 60,
            stat: "Sum",
            metrics: [
              ["AWS/AppSync", "Count", "GraphQLAPIId", apiId, { label: "Requests", color: "#2196F3" }],
              ["AWS/AppSync", "4XXError", "GraphQLAPIId", apiId, { label: "4XX Errors", color: "#FF9800" }],
              ["AWS/AppSync", "5XXError", "GraphQLAPIId", apiId, { label: "5XX Errors", color: "#F44336" }],
            ],
          },
        },
        {
          type: "metric",
          x: 8, y: 9, width: 8, height: 6,
          properties: {
            title: "Latency (ms)",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 60,
            metrics: [
              ["AWS/AppSync", "Latency", "GraphQLAPIId", apiId, { stat: "p50", label: "p50" }],
              ["AWS/AppSync", "Latency", "GraphQLAPIId", apiId, { stat: "p95", label: "p95" }],
              ["AWS/AppSync", "Latency", "GraphQLAPIId", apiId, { stat: "p99", label: "p99", color: "#F44336" }],
            ],
          },
        },
        {
          type: "metric",
          x: 16, y: 9, width: 8, height: 6,
          properties: {
            title: "Error Rate (%)",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 300,
            metrics: [
              [{ expression: "(m1+m2)/m3*100", label: "Total Error %", id: "e1", color: "#F44336" }],
              ["AWS/AppSync", "4XXError", "GraphQLAPIId", apiId, { id: "m1", visible: false, stat: "Sum" }],
              ["AWS/AppSync", "5XXError", "GraphQLAPIId", apiId, { id: "m2", visible: false, stat: "Sum" }],
              ["AWS/AppSync", "Count", "GraphQLAPIId", apiId, { id: "m3", visible: false, stat: "Sum" }],
            ],
          },
        },

        // ── Row 2: MCP Lambda ────────────────────────────────────────────
        {
          type: "text",
          x: 0, y: 15, width: 24, height: 1,
          properties: { markdown: "## MCP Lambda" },
        },
        {
          type: "metric",
          x: 0, y: 16, width: 8, height: 6,
          properties: {
            title: "Invocations & Errors",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 60,
            stat: "Sum",
            metrics: [
              ["AWS/Lambda", "Invocations", "FunctionName", mcpFnName, { label: "Invocations", color: "#2196F3" }],
              ["AWS/Lambda", "Errors", "FunctionName", mcpFnName, { label: "Errors", color: "#F44336" }],
              ["AWS/Lambda", "Throttles", "FunctionName", mcpFnName, { label: "Throttles", color: "#FF9800" }],
            ],
          },
        },
        {
          type: "metric",
          x: 8, y: 16, width: 8, height: 6,
          properties: {
            title: "Duration (ms)",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 60,
            metrics: [
              ["AWS/Lambda", "Duration", "FunctionName", mcpFnName, { stat: "p50", label: "p50" }],
              ["AWS/Lambda", "Duration", "FunctionName", mcpFnName, { stat: "p95", label: "p95" }],
              ["AWS/Lambda", "Duration", "FunctionName", mcpFnName, { stat: "p99", label: "p99", color: "#F44336" }],
            ],
          },
        },
        {
          type: "metric",
          x: 16, y: 16, width: 8, height: 6,
          properties: {
            title: "Cold Starts & Concurrency",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 60,
            stat: "Sum",
            metrics: [
              ["AWS/Lambda", "InitDuration", "FunctionName", mcpFnName, { stat: "p99", label: "Init Duration p99 (ms)" }],
              ["AWS/Lambda", "ConcurrentExecutions", "FunctionName", mcpFnName, { stat: "Maximum", label: "Max Concurrent", color: "#9C27B0" }],
            ],
          },
        },

        // ── Row 3: CloudFront ────────────────────────────────────────────
        {
          type: "text",
          x: 0, y: 22, width: 24, height: 1,
          properties: { markdown: "## CloudFront CDN" },
        },
        {
          type: "metric",
          x: 0, y: 23, width: 12, height: 6,
          properties: {
            title: "API CDN — Requests & Error Rate",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 300,
            metrics: [
              ["AWS/CloudFront", "Requests", "DistributionId", cdnId, "Region", "Global", { stat: "Sum", label: "Requests", color: "#2196F3" }],
              ["AWS/CloudFront", "TotalErrorRate", "DistributionId", cdnId, "Region", "Global", { stat: "Average", label: "Total Error %", color: "#F44336", yAxis: "right" }],
            ],
            yAxis: { right: { max: 100, min: 0, label: "Error %" } },
          },
        },
        {
          type: "metric",
          x: 12, y: 23, width: 12, height: 6,
          properties: {
            title: "MCP CDN — Requests & Error Rate",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 300,
            metrics: [
              ["AWS/CloudFront", "Requests", "DistributionId", mcpCdnId, "Region", "Global", { stat: "Sum", label: "Requests", color: "#4CAF50" }],
              ["AWS/CloudFront", "TotalErrorRate", "DistributionId", mcpCdnId, "Region", "Global", { stat: "Average", label: "Total Error %", color: "#F44336", yAxis: "right" }],
            ],
            yAxis: { right: { max: 100, min: 0, label: "Error %" } },
          },
        },

        // ── Row 4: DynamoDB ──────────────────────────────────────────────
        {
          type: "text",
          x: 0, y: 29, width: 24, height: 1,
          properties: { markdown: "## DynamoDB" },
        },
        {
          type: "metric",
          x: 0, y: 30, width: 8, height: 6,
          properties: {
            title: "Consumed Capacity",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 60,
            stat: "Sum",
            metrics: [
              ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", tableName, { label: "Read RCU" }],
              ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", tableName, { label: "Write WCU" }],
            ],
          },
        },
        {
          type: "metric",
          x: 8, y: 30, width: 8, height: 6,
          properties: {
            title: "Latency (ms)",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 60,
            metrics: [
              ["AWS/DynamoDB", "SuccessfulRequestLatency", "TableName", tableName, "Operation", "GetItem", { stat: "p99", label: "GetItem p99" }],
              ["AWS/DynamoDB", "SuccessfulRequestLatency", "TableName", tableName, "Operation", "Query", { stat: "p99", label: "Query p99" }],
              ["AWS/DynamoDB", "SuccessfulRequestLatency", "TableName", tableName, "Operation", "PutItem", { stat: "p99", label: "PutItem p99" }],
              ["AWS/DynamoDB", "SuccessfulRequestLatency", "TableName", tableName, "Operation", "UpdateItem", { stat: "p99", label: "UpdateItem p99" }],
            ],
          },
        },
        {
          type: "metric",
          x: 16, y: 30, width: 8, height: 6,
          properties: {
            title: "Throttles & System Errors",
            region: REGION,
            view: "timeSeries",
            stacked: false,
            period: 60,
            stat: "Sum",
            metrics: [
              ["AWS/DynamoDB", "ReadThrottleEvents", "TableName", tableName, { label: "Read Throttles", color: "#FF9800" }],
              ["AWS/DynamoDB", "WriteThrottleEvents", "TableName", tableName, { label: "Write Throttles", color: "#F44336" }],
              ["AWS/DynamoDB", "SystemErrors", "TableName", tableName, { label: "System Errors", color: "#9C27B0" }],
            ],
          },
        },
      ],
    })
  ),
});
