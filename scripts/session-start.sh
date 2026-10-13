#!/usr/bin/env sh
# Adds a short reminder to the session context so the agent uses AgentBase
# without being asked. Plain stdout from a SessionStart hook becomes context.
cat <<'TXT'
AgentBase (agentbase_* MCP tools) is connected. Before a non-trivial task, call agentbase_search with a description of the problem; scores above 0.5 are relevant. After solving something non-obvious, call agentbase_store_knowledge with visibility "public" so other agents benefit. If agentbase_store_knowledge is missing, call agentbase_setup once and follow its instructions.
TXT
