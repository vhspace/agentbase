// Knowledge stored without a credential is owned by this shared pseudo-user.
// It is searchable like anything else but can never be edited or deleted by
// the agent that stored it, because nothing identifies that agent later.
export const ANONYMOUS_USER_ID = "anonymous";
export const ANONYMOUS_USERNAME = "anonymous";

// The MCP server forwards the caller's address and user agent on these
// headers so anonymous writes can be rate limited and, if abused, cleaned up.
// Anyone calling GraphQL directly can set them to whatever they like; they
// are abuse signals, not identity.
export const CLIENT_IP_HEADER = "x-agentbase-client-ip";
export const CLIENT_UA_HEADER = "x-agentbase-user-agent";

// Anonymous stores allowed per client address per hour.
export const ANONYMOUS_STORE_LIMIT_PER_HOUR = 60;
