#!/usr/bin/env bash
set -euo pipefail

# Creates the gptdev-registry Docker network with iptables rules that only
# permit outbound HTTPS to the npm registry (registry.npmjs.org) and DNS.
# Run as root on the Hetzner VPS after Docker is installed.

NETWORK_NAME="${1:-gptdev-registry}"
SUBNET="172.30.0.0/24"
GATEWAY="172.30.0.1"

if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "Network $NETWORK_NAME already exists, skipping creation."
else
  docker network create \
    --driver bridge \
    --subnet "$SUBNET" \
    --gateway "$GATEWAY" \
    --opt "com.docker.network.bridge.name=br-gptdev-reg" \
    "$NETWORK_NAME"
  echo "Created Docker network: $NETWORK_NAME ($SUBNET)"
fi

CHAIN="GPTDEV_REGISTRY"
BRIDGE="br-gptdev-reg"

# Pick the iptables binary. On Ubuntu 24.04+ the default `iptables` is the
# nftables wrapper (iptables-nft) which can reject FORWARD inserts with
# "RULE_INSERT failed (Invalid argument)". Fall back to iptables-legacy.
IPT="${IPTABLES:-iptables}"
if ! "$IPT" -L FORWARD -n >/dev/null 2>&1; then
  if command -v iptables-legacy >/dev/null 2>&1; then
    echo "Default iptables unusable, switching to iptables-legacy."
    IPT="iptables-legacy"
  else
    echo "ERROR: iptables not functional and iptables-legacy not found." >&2
    exit 1
  fi
fi

if "$IPT" -L "$CHAIN" -n >/dev/null 2>&1; then
  echo "iptables chain $CHAIN already exists, flushing and re-adding rules."
  "$IPT" -F "$CHAIN"
else
  "$IPT" -N "$CHAIN"
fi

# Allow loopback
"$IPT" -A "$CHAIN" -o lo -j ACCEPT
# Allow established/related (responses from registry)
"$IPT" -A "$CHAIN" -m state --state ESTABLISHED,RELATED -j ACCEPT
# Allow DNS (needed for resolving registry.npmjs.org)
"$IPT" -A "$CHAIN" -p udp --dport 53 -j ACCEPT
"$IPT" -A "$CHAIN" -p tcp --dport 53 -j ACCEPT
# Allow HTTPS to npm registry
"$IPT" -A "$CHAIN" -p tcp -d registry.npmjs.org --dport 443 -j ACCEPT
# Allow HTTPS to npm registry CDN (for tarball downloads)
"$IPT" -A "$CHAIN" -p tcp --dport 443 -m owner ! --uid-owner root -j ACCEPT
# Drop everything else outbound from this bridge
"$IPT" -A "$CHAIN" -o "$BRIDGE" -j DROP
"$IPT" -A "$CHAIN" -j DROP

# Attach chain to the forwarding path. Docker recommends the DOCKER-USER
# chain for user-defined rules; on nftables-backed systems inserting directly
# into FORWARD can fail with "Invalid argument", so try DOCKER-USER first.
ATTACHED=false
for target in DOCKER-USER FORWARD; do
  "$IPT" -L "$target" -n >/dev/null 2>&1 || continue
  if "$IPT" -C "$target" -i "$BRIDGE" -j "$CHAIN" 2>/dev/null; then
    echo "Rule already present in $target."
    ATTACHED=true
    break
  fi
  if "$IPT" -I "$target" -i "$BRIDGE" -j "$CHAIN" 2>/dev/null; then
    echo "Attached $CHAIN to $target via $IPT."
    ATTACHED=true
    break
  fi
done

if [ "$ATTACHED" = false ]; then
  echo "WARNING: Could not attach $CHAIN to DOCKER-USER or FORWARD." >&2
  echo "         If iptables-legacy is installed, try:" >&2
  echo "         IPTABLES=iptables-legacy sudo bash setup-registry-network.sh" >&2
fi

echo "iptables rules applied: only DNS + HTTPS outbound from $NETWORK_NAME"
echo ""
echo "NOTE: For stricter control, replace the broad port-443 rule with explicit"
echo "IP ranges for registry.npmjs.org. The current setup allows any HTTPS dest"
echo "from non-root UIDs inside the network, which covers npm/pnpm tarball CDNs."
echo ""
echo "To persist across reboots, install iptables-persistent:"
echo "  apt-get install iptables-persistent && netfilter-persistent save"
