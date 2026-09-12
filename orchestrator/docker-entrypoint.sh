#!/bin/sh
set -eu

required_vars="CRE_AUTH_CONFIG_B64 CRE_ETH_PRIVATE_KEY SECRET_PROVIDER_STRATEGY SECRET_PROVIDER_STRATEGY_DEFENSIVE SECRET_MAKER_LIMITS SECRET_ENVELOPE_PRIVATE_KEY"
for name in $required_vars; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "Missing required runtime variable: $name" >&2
    exit 1
  fi
done

umask 077
printf '%s' "$CRE_AUTH_CONFIG_B64" | base64 -d > /home/node/.cre/cre.yaml
cat > /workspace/workflow/.env <<EOF
CRE_ETH_PRIVATE_KEY=$CRE_ETH_PRIVATE_KEY
CRE_TARGET=${CRE_TARGET:-staging-settings}
SECRET_PROVIDER_STRATEGY=$SECRET_PROVIDER_STRATEGY
SECRET_PROVIDER_STRATEGY_DEFENSIVE=$SECRET_PROVIDER_STRATEGY_DEFENSIVE
SECRET_MAKER_LIMITS=$SECRET_MAKER_LIMITS
SECRET_ENVELOPE_PRIVATE_KEY=$SECRET_ENVELOPE_PRIVATE_KEY
EOF

# Validate the renewable CLI credential and populate CRE's runtime context
# before the HTTP service begins accepting confidential requests.
cre whoami >/dev/null

exec node src/server.mjs
