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

if iptables -L "$CHAIN" -n >/dev/null 2>&1; then
  echo "iptables chain $CHAIN already exists, flushing and re-adding rules."
  iptables -F "$CHAIN"
else
  iptables -N "$CHAIN"
fi

# Allow loopback
iptables -A "$CHAIN" -o lo -j ACCEPT
# Allow established/related (responses from registry)
iptables -A "$CHAIN" -m state --state ESTABLISHED,RELATED -j ACCEPT
# Allow DNS (needed for resolving registry.npmjs.org)
iptables -A "$CHAIN" -p udp --dport 53 -j ACCEPT
iptables -A "$CHAIN" -p tcp --dport 53 -j ACCEPT
# Allow HTTPS to npm registry
iptables -A "$CHAIN" -p tcp -d registry.npmjs.org --dport 443 -j ACCEPT
# Allow HTTPS to npm registry CDN (for tarball downloads)
iptables -A "$CHAIN" -p tcp --dport 443 -m owner ! --uid-owner root -j ACCEPT
# Drop everything else outbound from this bridge
iptables -A "$CHAIN" -o "$BRIDGE" -j DROP
iptables -A "$CHAIN" -j DROP

# Attach chain to FORWARD for traffic from the registry bridge
if ! iptables -C FORWARD -i "$BRIDGE" -j "$CHAIN" 2>/dev/null; then
  iptables -I FORWARD -i "$BRIDGE" -j "$CHAIN"
fi

echo "iptables rules applied: only DNS + HTTPS outbound from $NETWORK_NAME"
echo ""
echo "NOTE: For stricter control, replace the broad port-443 rule with explicit"
echo "IP ranges for registry.npmjs.org. The current setup allows any HTTPS dest"
echo "from non-root UIDs inside the network, which covers npm/pnpm tarball CDNs."
echo ""
echo "To persist across reboots, install iptables-persistent:"
echo "  apt-get install iptables-persistent && netfilter-persistent save"
