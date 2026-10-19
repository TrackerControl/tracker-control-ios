# Raspberry Pi Analyser Setup

This guide sets up a Raspberry Pi as the always-on analyser host for `analyser/processQueue.sh`.

Use a dedicated system user rather than `root`. The setup script below creates `trackerios`, installs the checkout into `/opt/tracker-control-ios`, and installs a systemd service named `tracker-control-ios-analyser`.

## Requirements

- 64-bit Raspberry Pi OS.
- A jailbroken iPhone reachable over USB/SSH.
- `trackerscan` installed on the iPhone.
- `appinst` installed on the iPhone.
- A deployed web server with matching `UPLOAD_PASSWORD`.
- An Apple ID that can use App Store downloads through `ipatool`.

The Pi does not need macOS plist tools. IPA preflight, permission extraction, raw `Info.plist` storage, and app-extension pruning use Python's standard `plistlib`.

## Install

Clone or copy this repository onto the Pi, then run:

```sh
sudo bash scripts/setup-raspi-analyser.sh
```

The script installs:

- `nodejs`, `npm`
- `python3`
- `unzip`, `zip`
- `curl`, `git`, `openssh-client`, `rsync`
- `libimobiledevice-utils`, `ideviceinstaller`, `usbmuxd`
- `ipatool` for Linux arm64, unless it is already installed

You can override defaults:

```sh
sudo ANALYSER_USER=trackerios \
  INSTALL_DIR=/opt/tracker-control-ios \
  SERVICE_NAME=tracker-control-ios-analyser \
  IPATOOL_VERSION=2.5.0 \
  bash scripts/setup-raspi-analyser.sh
```

The script does not start the service unless `START_SERVICE=1` is set. Configure `.env`, SSH, and `ipatool` first.

For a fresh host, the installer delegates `ipatool` installation to
`scripts/manage-raspi-ipatool.sh`. It verifies the official GitHub release
checksum before replacing the binary and preserves the analyser's service
state. An active service is stopped only for the replacement and restarted
afterwards; an inactive or not-yet-created service is left alone. If
`ipatool` already exists, rerunning setup leaves that binary untouched; use the
maintenance command below for an explicit upgrade.

## Configure `.env`

Edit:

```sh
sudo nano /opt/tracker-control-ios/analyser/.env
```

Minimum useful config:

```sh
SERVER=https://your-railway-app.example
UPLOAD_PASSWORD=change-me
ANALYSIS_VERSION=4
ANALYSIS_MODE=trackerscan
TRACKERSCAN_CMD="ssh iphone trackerscan"
TRACKERSCAN_SIGNATURES=/var/mobile/ios_signatures_v2.json
TRACKERSCAN_SIGNATURE_SET=ios-v2
IPATOOL_KEYCHAIN_PASSPHRASE=change-me-local-passphrase
PASS=$IPATOOL_KEYCHAIN_PASSPHRASE
RUN_ONCE=0
LIVE_LOG=1
```

Safety defaults are already present in `.env.example`:

```sh
MAX_DOWNLOAD_ATTEMPTS=2
MAX_DAILY_DOWNLOAD_BYTES=50000000000
MAX_APP_SIZE_BYTES=1800000000
MAX_ATTEMPT_DOWNLOAD_BYTES=1800000000
CONSECUTIVE_FAILURE_LIMIT=5
CIRCUIT_BREAKER_SLEEP=3600
DOWNLOAD_WATCHDOG_INTERVAL=5
```

Set `NETWORK_INTERFACE` only if auto-detection picks the wrong interface. On a Pi this is often `eth0` or `wlan0`.

## Use RAM-Backed IPA Storage

Raspberry Pi OS commonly mounts `/tmp` as `tmpfs`. Use it for transient IPA downloads to reduce SD-card writes. Keep IPAs in a dedicated subdirectory rather than symlinking `ipas/` directly to `/tmp`, because the analyser removes `ipas/*.tmp` during cleanup.

Check that `/tmp` is RAM-backed:

```sh
findmnt /tmp
```

Move the IPA work directory:

```sh
sudo systemctl stop tracker-control-ios-analyser
sudo rm -rf /opt/tracker-control-ios/analyser/ipas
sudo mkdir -p /tmp/tracker-control-ios-ipas
sudo chown trackerios:trackerios /tmp/tracker-control-ios-ipas
sudo ln -s /tmp/tracker-control-ios-ipas /opt/tracker-control-ios/analyser/ipas
```

Because `/tmp` is recreated on boot, add a tmpfiles rule:

```sh
echo 'd /tmp/tracker-control-ios-ipas 0755 trackerios trackerios -' | sudo tee /etc/tmpfiles.d/tracker-control-ios.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/tracker-control-ios.conf
```

As an extra guard against service ordering issues, add a systemd override that recreates the directory immediately before the analyser starts:

```sh
sudo systemctl edit tracker-control-ios-analyser
```

Add:

```ini
[Service]
ExecStartPre=/bin/mkdir -p /tmp/tracker-control-ios-ipas
ExecStartPre=/bin/chown trackerios:trackerios /tmp/tracker-control-ios-ipas
```

Then reload and restart:

```sh
sudo systemctl daemon-reload
sudo systemctl restart tracker-control-ios-analyser
```

On a 2 GB `/tmp`, keep the IPA limits below that mount size in `/opt/tracker-control-ios/analyser/.env`:

```sh
MAX_APP_SIZE_BYTES=1800000000
MAX_ATTEMPT_DOWNLOAD_BYTES=1800000000
PRESERVE_IPAS=0
```

## Configure SSH To The Phone

The analyser uses two SSH aliases:

- `iphone`: used by `TRACKERSCAN_CMD`, default `ssh iphone trackerscan`
- `ios`: used by `analyser/appinst.sh` to copy a patched IPA and run `appinst`

Create SSH keys and config for the analyser user:

```sh
sudo -u trackerios ssh-keygen -t ed25519 -f /var/lib/trackerios/.ssh/id_ed25519
sudo -u trackerios nano /var/lib/trackerios/.ssh/config
```

Example config when using `iproxy` on localhost:

```sshconfig
Host iphone
  HostName 127.0.0.1
  Port 2222
  User root
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new

Host ios
  HostName 127.0.0.1
  Port 2222
  User root
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new
```

If the phone has OpenSSH reachable directly over Wi-Fi, use its IP and port instead.

If you rely on `iproxy`, run it as a separate service or keep it running before starting the analyser. The analyser service assumes SSH is already reachable.

Test both aliases:

```sh
sudo -u trackerios ssh iphone 'command -v trackerscan'
sudo -u trackerios ssh ios 'command -v appinst'
```

## Upgrade Or Recover `ipatool`

From the deployed checkout, upgrade to the latest stable release:

```sh
sudo bash /opt/tracker-control-ios/scripts/manage-raspi-ipatool.sh upgrade
```

`latest` is the default and is resolved from the official `majd/ipatool`
GitHub releases endpoint. To pin an explicit release instead, pass its version:

```sh
sudo bash /opt/tracker-control-ios/scripts/manage-raspi-ipatool.sh upgrade 2.5.0
```

The manager downloads the exact Linux arm64/aarch64 or amd64/x86_64 tarball
and its `.sha256sum` asset, validates the checksum before stopping the service
or installing anything, and locates the executable in the archive. If the
requested version is already installed, it exits without disruption. Before a
replacement it writes a timestamped rollback copy beside the configured binary,
for example `/usr/local/bin/ipatool.rollback.20260908153000`; the path is
printed by the command.

If the stored App Store login needs recovery, run:

```sh
sudo bash /opt/tracker-control-ios/scripts/manage-raspi-ipatool.sh reauth
```

`reauth` reads `APPLE_EMAIL` and `PASS` (falling back to
`IPATOOL_KEYCHAIN_PASSPHRASE`) from `/opt/tracker-control-ios/analyser/.env`
inside the unprivileged `trackerios` shell, then runs `ipatool auth login` and
`ipatool auth info` with `HOME=/var/lib/trackerios`. It never supplies an Apple
password on the command line: enter the Apple password and any two-factor
authentication interactively. If the analyser was active, the command stops it
for the login and resumes it even when authentication fails; an inactive
service remains inactive.

For a manual check without changing the stored login, run as the analyser user:

```sh
sudo -u trackerios env HOME=/var/lib/trackerios \
  ipatool auth info \
  --keychain-passphrase change-me-local-passphrase
```

Then test a small download manually if needed:

```sh
cd /opt/tracker-control-ios/analyser
sudo -u trackerios env HOME=/var/lib/trackerios RUN_ONCE=1 ONLY_APP_ID=com.spotify.client bash processQueue.sh
```

## Start The Service

Start:

```sh
sudo systemctl start tracker-control-ios-analyser
```

Watch logs:

```sh
journalctl -u tracker-control-ios-analyser -f
```

Stop:

```sh
sudo systemctl stop tracker-control-ios-analyser
```

Restart after config changes:

```sh
sudo systemctl restart tracker-control-ios-analyser
```

Check status:

```sh
systemctl status tracker-control-ios-analyser
```

## Run One Specific App

For a one-off test without queue priority:

```sh
cd /opt/tracker-control-ios/analyser
sudo -u trackerios env HOME=/var/lib/trackerios ONLY_APP_ID=com.spotify.client bash processQueue.sh
```

This snapshots and clears the app's current analysis, processes exactly that app, uploads the result, and exits.

## Updating The Pi Deployment

From a fresh checkout with new code:

```sh
sudo bash scripts/setup-raspi-analyser.sh
sudo systemctl restart tracker-control-ios-analyser
```

The installer preserves `/opt/tracker-control-ios/analyser/.env` and runtime directories such as `ipas/`, `analysis/`, and `trackerscan/`. If `ipas/` is a symlink to `/tmp/tracker-control-ios-ipas`, rerunning the installer preserves the symlink target setup.

## Railway Server Notes

Set the same `UPLOAD_PASSWORD` on Railway and on the Pi. The analyser sends it as an `Authorization: Bearer` header.

Raw scanner output can exceed Express' default body size. The server now defaults to `BODY_LIMIT=25mb`. On Railway, set a higher value if uploads fail with HTTP 413:

```text
BODY_LIMIT=50mb
```

## Troubleshooting

If the service says `UPLOAD_PASSWORD is not set`, edit `/opt/tracker-control-ios/analyser/.env`.

If downloads fail, run:

```sh
sudo -u trackerios env HOME=/var/lib/trackerios ipatool auth info
```

If installs fail with an unknown extension point, check that `python3`, `unzip`, and `appinst` are available. The analyser should detect incompatible extension points, remove only those `.appex` bundles, and install via `appinst`.

If SSH fails under systemd but works in your shell, make sure the SSH config and keys live under `/var/lib/trackerios/.ssh`, not under your normal user.

If `ideviceinstaller` cannot see the phone, check USB pairing and `usbmuxd`:

```sh
idevice_id -l
systemctl status usbmuxd
```
