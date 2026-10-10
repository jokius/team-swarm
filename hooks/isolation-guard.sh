#!/bin/sh
# team-swarm isolation guard, cheap pre-filter: PreToolUse runs on every matching tool call
# in every session, so only start node for team-swarm role teammates (agent_type = name).
input=$(cat)
case "$input" in
  *'"agent_type":"tester-'* | *'"agent_type":"developer-'* | *'"agent_type":"worker-'*)
    printf '%s' "$input" | exec node "$(dirname "$0")/isolation-guard.mjs" ;;
esac
exit 0
