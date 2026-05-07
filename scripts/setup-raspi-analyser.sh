#!/usr/bin/env bash
set -euo pipefail

ANALYSER_USER="${ANALYSER_USER:-trackerios}"
INSTALL_DIR="${INSTALL_DIR:-/opt/tracker-control-ios}"
SERVICE_NAME="${SERVICE_NAME:-tracker-control-ios-analyser}"
INSTALL_IPATOOL="${INSTALL_IPATOOL:-1}"
IPATOOL_VERSION="${IPATOOL_VERSION:-2.3.0}"
START_SERVICE="${START_SERVICE:-0}"

SCRIPT_DIR="$(cd -- "$(dirname "$0")" >/dev/null 2>&1; pwd -P)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1; pwd -P)"
ANALYSER_HOME="/var/lib/$ANALYSER_USER"

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
	echo "Run this script as root, for example: sudo bash scripts/setup-raspi-analyser.sh" >&2
	exit 1
fi

if [ ! -f "$SOURCE_DIR/analyser/processQueue.sh" ]; then
	echo "Could not find analyser/processQueue.sh. Run this from a tracker-control-ios checkout." >&2
	exit 1
fi

arch="$(uname -m)"
case "$arch" in
	aarch64|arm64)
		ipatool_arch="arm64"
		;;
	x86_64|amd64)
		ipatool_arch="amd64"
		;;
	*)
		echo "Unsupported architecture for prebuilt ipatool: $arch. Use a 64-bit Raspberry Pi OS." >&2
		exit 1
		;;
esac

echo "Installing host packages"
apt-get update
apt-get install -y \
	ca-certificates \
	curl \
	git \
	ideviceinstaller \
	libimobiledevice-utils \
	nodejs \
	npm \
	openssh-client \
	python3 \
	rsync \
	unzip \
	usbmuxd \
	zip

if ! id "$ANALYSER_USER" >/dev/null 2>&1; then
	echo "Creating analyser user $ANALYSER_USER"
	useradd --system --create-home --home-dir "$ANALYSER_HOME" --shell /bin/bash "$ANALYSER_USER"
fi

if getent group plugdev >/dev/null 2>&1; then
	usermod -aG plugdev "$ANALYSER_USER"
fi

if [ "$INSTALL_IPATOOL" = "1" ] && ! command -v ipatool >/dev/null 2>&1; then
	echo "Installing ipatool $IPATOOL_VERSION for linux-$ipatool_arch"
	tmpdir="$(mktemp -d)"
	trap 'rm -rf "$tmpdir"' EXIT
	curl -fsSL \
		"https://github.com/majd/ipatool/releases/download/v${IPATOOL_VERSION}/ipatool-${IPATOOL_VERSION}-linux-${ipatool_arch}.tar.gz" \
		-o "$tmpdir/ipatool.tar.gz"
	tar -xzf "$tmpdir/ipatool.tar.gz" -C "$tmpdir"
	ipatool_bin="$(find "$tmpdir" -type f -perm -111 -name 'ipatool*' | head -n 1)"
	if [ -z "$ipatool_bin" ]; then
		echo "Could not find ipatool executable in downloaded archive." >&2
		find "$tmpdir" -maxdepth 3 -type f >&2
		exit 1
	fi
	install -m 0755 "$ipatool_bin" /usr/local/bin/ipatool
	rm -rf "$tmpdir"
	trap - EXIT
fi

echo "Installing checkout into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
rsync -a --delete \
	--exclude '.git/' \
	--exclude 'node_modules/' \
	--exclude 'backups/' \
	--exclude 'cache/' \
	--exclude 'analyser/.env' \
	--exclude 'analyser/analysis/' \
	--exclude 'analyser/classes/' \
	--exclude 'analyser/ipas/' \
	--exclude 'analyser/trackerscan/' \
	--exclude 'analyser/trackerscan-ios/' \
	--exclude 'analyser/*.ipa' \
	--exclude 'analyser/*.tmp' \
	--exclude 'analyser/daily-download-bytes.txt' \
	--exclude 'analyser/processing.log' \
	"$SOURCE_DIR/" "$INSTALL_DIR/"

mkdir -p \
	"$INSTALL_DIR/analyser/analysis" \
	"$INSTALL_DIR/analyser/classes" \
	"$INSTALL_DIR/analyser/ipas" \
	"$INSTALL_DIR/analyser/trackerscan"

if [ ! -f "$INSTALL_DIR/analyser/.env" ]; then
	cp "$INSTALL_DIR/analyser/.env.example" "$INSTALL_DIR/analyser/.env"
	chmod 0600 "$INSTALL_DIR/analyser/.env"
	echo "Created $INSTALL_DIR/analyser/.env from .env.example. Edit it before starting the service."
fi

chmod +x \
	"$INSTALL_DIR/analyser/processQueue.sh" \
	"$INSTALL_DIR/analyser/appinst.sh" \
	"$INSTALL_DIR/analyser/plist_value.py" \
	"$INSTALL_DIR/analyser/plist_to_json.py"

chown -R "$ANALYSER_USER:$ANALYSER_USER" "$INSTALL_DIR" "$ANALYSER_HOME"

echo "Installing Node dependencies"
runuser -u "$ANALYSER_USER" -- env HOME="$ANALYSER_HOME" npm --prefix "$INSTALL_DIR" ci --omit=dev

echo "Installing systemd service $SERVICE_NAME"
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=TrackerControl iOS analyser
Wants=network-online.target usbmuxd.service
After=network-online.target usbmuxd.service

[Service]
Type=simple
User=$ANALYSER_USER
Group=$ANALYSER_USER
WorkingDirectory=$INSTALL_DIR/analyser
Environment=HOME=$ANALYSER_HOME
ExecStart=/bin/bash $INSTALL_DIR/analyser/processQueue.sh
Restart=always
RestartSec=30
KillSignal=SIGINT
TimeoutStopSec=30
LimitNOFILE=32768
NoNewPrivileges=true
PrivateTmp=true
ReadWritePaths=$INSTALL_DIR/analyser $ANALYSER_HOME

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

cat <<EOF

Setup complete.

Next steps:
1. Edit $INSTALL_DIR/analyser/.env
2. Install/build trackerscan on the jailbroken iPhone
3. Configure SSH aliases for the $ANALYSER_USER user:
   runuser -u $ANALYSER_USER -- ssh iphone true
   runuser -u $ANALYSER_USER -- ssh ios 'command -v appinst'
4. Log in to ipatool:
   runuser -u $ANALYSER_USER -- env HOME=$ANALYSER_HOME ipatool auth login
5. Start the analyser:
   sudo systemctl start $SERVICE_NAME
6. Watch logs:
   journalctl -u $SERVICE_NAME -f

EOF

if [ "$START_SERVICE" = "1" ]; then
	systemctl start "$SERVICE_NAME"
fi
