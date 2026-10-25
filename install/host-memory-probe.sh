#!/bin/sh
# Run from the Haus NVR checkout as root. Exports RAM capacity only, never raw DMI.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run this installer as root.' >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_dir=$(dirname -- "$script_dir")
node_bin=$(command -v node)
install -d -m 0755 /usr/local/lib/haus-host-memory /var/lib/haus-host-telemetry
install -m 0644 "$source_dir/lib/host-memory.mjs" "$source_dir/lib/host-memory-probe.mjs" /usr/local/lib/haus-host-memory/
# Copy the executable into the root-owned sandbox: an nvm/user-home symlink
# cannot be executed under ProtectHome and must not remain mutable by that user.
install -m 0755 "$node_bin" /usr/local/lib/haus-host-memory/node
cat > /etc/systemd/system/haus-host-memory.service <<UNIT
[Unit]
Description=Haus read-only installed memory inventory
[Service]
Type=oneshot
ExecStart=/usr/local/lib/haus-host-memory/node /usr/local/lib/haus-host-memory/host-memory-probe.mjs --output /var/lib/haus-host-telemetry/installed-memory.json
User=root
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
ReadWritePaths=/var/lib/haus-host-telemetry
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX
IPAddressDeny=any
UMask=0022
UNIT
cat > /etc/systemd/system/haus-host-memory.timer <<'UNIT'
[Unit]
Description=Refresh Haus installed memory inventory
[Timer]
OnBootSec=20s
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl start haus-host-memory.service
systemctl enable --now haus-host-memory.timer
