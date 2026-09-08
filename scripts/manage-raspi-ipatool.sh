#!/usr/bin/env bash
set -euo pipefail

ANALYSER_USER="${ANALYSER_USER:-trackerios}"
INSTALL_DIR="${INSTALL_DIR:-/opt/tracker-control-ios}"
SERVICE_NAME="${SERVICE_NAME:-tracker-control-ios-analyser}"
IPATOOL_INSTALL_PATH="${IPATOOL_INSTALL_PATH:-/usr/local/bin/ipatool}"
RESTART_SERVICE="${RESTART_SERVICE:-1}"

UPGRADE_TMPDIR=""
UPGRADE_ARCHIVE=""
UPGRADE_CHECKSUM=""
UPGRADE_BINARY=""
STAGING_PATH=""
ROLLBACK_PATH=""
SERVICE_NEEDS_RESUME=0

readonly RELEASES_API="https://api.github.com/repos/majd/ipatool/releases/latest"
readonly RELEASES_BASE="https://github.com/majd/ipatool/releases/download"

usage() {
	cat <<'EOF'
Usage:
  sudo bash scripts/manage-raspi-ipatool.sh upgrade [VERSION|latest]
  sudo bash scripts/manage-raspi-ipatool.sh reauth

upgrade defaults to latest and verifies the official release checksum before
replacing the installed binary. reauth prompts interactively for the Apple
password and any two-factor authentication.
EOF
}

require_root() {
	if [ "$(id -u)" -ne 0 ]; then
		echo "Run this command as root, for example: sudo bash $0 $*" >&2
		exit 1
	fi
}

normalise_version() {
	local version="$1"
	version="${version#v}"
	if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
		echo "Unsupported ipatool version: $1" >&2
		return 1
	fi
	printf '%s\n' "$version"
}

resolve_latest_version() {
	local response tag
	response="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$RELEASES_API")"
	tag="$(printf '%s' "$response" | tr '\n' ' ' | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
	if [ -z "$tag" ]; then
		echo "Could not determine the latest ipatool release from GitHub." >&2
		return 1
	fi
	normalise_version "$tag"
}

platform_arch() {
	if [ "$(uname -s)" != "Linux" ]; then
		echo "ipatool prebuilt upgrades are supported on Linux only." >&2
		return 1
	fi
	case "$(uname -m)" in
		aarch64|arm64)
		printf '%s\n' arm64
		;;
		x86_64|amd64)
		printf '%s\n' amd64
		;;
		*)
			echo "Unsupported architecture for prebuilt ipatool: $(uname -m). Use Linux arm64/aarch64 or amd64/x86_64." >&2
			return 1
			;;
	esac
}

installed_version() {
	local output
	if [ ! -x "$IPATOOL_INSTALL_PATH" ]; then
		return 0
	fi
	output="$("$IPATOOL_INSTALL_PATH" --version 2>/dev/null || true)"
	if [[ ! "$output" =~ [0-9]+\.[0-9]+\.[0-9]+ ]]; then
		output="$("$IPATOOL_INSTALL_PATH" version 2>/dev/null || true)"
	fi
	printf '%s\n' "$output" | sed -nE 's/.*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1
}

verify_checksum() {
	local checksum_file="$1"
	local archive="$2"
	local expected
	expected="$(awk 'NF { print $1; exit }' "$checksum_file")"
	if [[ ! "$expected" =~ ^[[:xdigit:]]{64}$ ]]; then
		echo "Invalid SHA-256 checksum asset: $checksum_file" >&2
		return 1
	fi
	if command -v sha256sum >/dev/null 2>&1; then
		printf '%s  %s\n' "$expected" "$archive" | sha256sum -c -
	else
		local actual
		actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
		[ "$actual" = "$expected" ]
	fi
}

service_is_active() {
	systemctl is-active --quiet "$SERVICE_NAME"
}

restore_active_service() {
	if [ "$SERVICE_NEEDS_RESUME" != "1" ]; then
		return 0
	fi
	echo "Attempting to restore active service $SERVICE_NAME" >&2
	if systemctl start "$SERVICE_NAME"; then
		SERVICE_NEEDS_RESUME=0
		return 0
	fi
	echo "Could not restore $SERVICE_NAME; start it manually." >&2
	return 1
}

restore_service_on_exit() {
	local status=$?
	trap - EXIT
	if ! restore_active_service; then
		status=1
	fi
	if [ -n "$STAGING_PATH" ]; then
		rm -f -- "$STAGING_PATH" || true
		STAGING_PATH=""
	fi
	if [ -n "$UPGRADE_TMPDIR" ]; then
		rm -rf -- "$UPGRADE_TMPDIR" || true
		UPGRADE_TMPDIR=""
	fi
	exit "$status"
}

trap restore_service_on_exit EXIT

release_version() {
	local requested="$1"
	if [ "$requested" = latest ]; then
		resolve_latest_version
	else
		normalise_version "$requested"
	fi
}

acquire_release() {
	local version="$1"
	local arch="$2"
	UPGRADE_TMPDIR="$(mktemp -d)"
	UPGRADE_ARCHIVE="$UPGRADE_TMPDIR/ipatool-${version}-linux-${arch}.tar.gz"
	UPGRADE_CHECKSUM="$UPGRADE_TMPDIR/ipatool-${version}-linux-${arch}.tar.gz.sha256sum"
	curl -fsSL \
		"${RELEASES_BASE}/v${version}/ipatool-${version}-linux-${arch}.tar.gz" \
		-o "$UPGRADE_ARCHIVE"
	curl -fsSL \
		"${RELEASES_BASE}/v${version}/ipatool-${version}-linux-${arch}.tar.gz.sha256sum" \
		-o "$UPGRADE_CHECKSUM"
	verify_checksum "$UPGRADE_CHECKSUM" "$UPGRADE_ARCHIVE"
	tar -xzf "$UPGRADE_ARCHIVE" -C "$UPGRADE_TMPDIR"
	UPGRADE_BINARY="$(find "$UPGRADE_TMPDIR" -type f -perm -111 \( -name ipatool -o -name 'ipatool-*' \) -print -quit)"
	if [ -z "$UPGRADE_BINARY" ]; then
		echo "Could not find ipatool executable in downloaded archive." >&2
		find "$UPGRADE_TMPDIR" -maxdepth 3 -type f >&2
		return 1
	fi
}

stop_active_service() {
	[ "$RESTART_SERVICE" = "1" ] || return 0
	service_is_active || return 0
	SERVICE_NEEDS_RESUME=1
	echo "Stopping active service $SERVICE_NAME"
	if systemctl stop "$SERVICE_NAME"; then
		return 0
	fi
	echo "Could not stop $SERVICE_NAME; attempting to restore it." >&2
	return 1
}

preserve_rollback_binary() {
	local stamp
	if [ ! -e "$IPATOOL_INSTALL_PATH" ] && [ ! -L "$IPATOOL_INSTALL_PATH" ]; then
		return 0
	fi
	stamp="$(date -u +%Y%m%d%H%M%S)"
	ROLLBACK_PATH="${IPATOOL_INSTALL_PATH}.rollback.${stamp}"
	while [ -e "$ROLLBACK_PATH" ] || [ -L "$ROLLBACK_PATH" ]; do
		stamp="$(date -u +%Y%m%d%H%M%S)-$$"
		ROLLBACK_PATH="${IPATOOL_INSTALL_PATH}.rollback.${stamp}"
	done
	cp -p -- "$IPATOOL_INSTALL_PATH" "$ROLLBACK_PATH"
	echo "Preserved rollback copy at $ROLLBACK_PATH"
}

stage_install_binary() {
	local destination_dir
	destination_dir="$(dirname -- "$IPATOOL_INSTALL_PATH")"
	mkdir -p -- "$destination_dir"
	STAGING_PATH="$destination_dir/.ipatool.install.$$.$RANDOM"
	while [ -e "$STAGING_PATH" ] || [ -L "$STAGING_PATH" ]; do
		STAGING_PATH="$destination_dir/.ipatool.install.$$.$RANDOM"
	done
	install -m 0755 "$UPGRADE_BINARY" "$STAGING_PATH"
	mv -f -- "$STAGING_PATH" "$IPATOOL_INSTALL_PATH"
	STAGING_PATH=""
}

verify_installed_binary() {
	local requested_version="$1"
	local version_output reported_version
	version_output="$("$IPATOOL_INSTALL_PATH" --version 2>/dev/null || true)"
	reported_version="$(printf '%s\n' "$version_output" | sed -nE 's/.*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1)"
	if [ -z "$reported_version" ]; then
		version_output="$("$IPATOOL_INSTALL_PATH" version 2>/dev/null || true)"
		reported_version="$(printf '%s\n' "$version_output" | sed -nE 's/.*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1)"
	fi
	[ "$reported_version" = "$requested_version" ]
}

restore_previous_binary() {
	if [ -n "$ROLLBACK_PATH" ]; then
		if cp -p -- "$ROLLBACK_PATH" "$IPATOOL_INSTALL_PATH"; then
			return 0
		fi
		echo "Could not restore the previous ipatool binary." >&2
		return 1
	fi
	if rm -f -- "$IPATOOL_INSTALL_PATH"; then
		return 0
	fi
	echo "Could not remove the unverified ipatool binary." >&2
	return 1
}

verify_or_restore_binary() {
	local version="$1"
	if verify_installed_binary "$version"; then
		return 0
	fi
	echo "Installed ipatool did not report requested version $version; restoring the previous binary." >&2
	restore_previous_binary || true
	restore_active_service || true
	return 1
}

restart_active_service() {
	[ "$SERVICE_NEEDS_RESUME" = "1" ] || return 0
	echo "Restarting $SERVICE_NAME"
	restore_active_service
}

upgrade() {
	local requested="${1:-latest}"
	local version arch installed
	version="$(release_version "$requested")"
	arch="$(platform_arch)"
	installed="$(installed_version)"
	if [ "$installed" = "$version" ]; then
		echo "ipatool $version is already installed at $IPATOOL_INSTALL_PATH; nothing to do."
		return 0
	fi
	acquire_release "$version" "$arch"
	if ! stop_active_service; then
		return 1
	fi
	preserve_rollback_binary
	stage_install_binary
	if ! verify_or_restore_binary "$version"; then
		return 1
	fi
	echo "Installed ipatool $version at $IPATOOL_INSTALL_PATH"
	if ! restart_active_service; then
		return 1
	fi
}

reauth() {
	local auth_status=0

	if service_is_active; then
		SERVICE_NEEDS_RESUME=1
		echo "Stopping active service $SERVICE_NAME"
		if ! systemctl stop "$SERVICE_NAME"; then
			echo "Could not stop $SERVICE_NAME; attempting to restore it." >&2
			return 1
		fi
	fi

	if runuser -u "$ANALYSER_USER" -- env \
		"HOME=/var/lib/$ANALYSER_USER" \
		"INSTALL_DIR=$INSTALL_DIR" \
		"IPATOOL_INSTALL_PATH=$IPATOOL_INSTALL_PATH" \
		bash -c '
			set -eo pipefail
			env_file="$INSTALL_DIR/analyser/.env"
			if [ ! -f "$env_file" ]; then
				echo "Could not find $env_file." >&2
				exit 1
			fi
			# This file is intentionally sourced only in the unprivileged shell.
			. "$env_file"
			set -u
			unset APPLE_PASS
			apple_email="${APPLE_EMAIL:-}"
			keychain_passphrase="${PASS:-${IPATOOL_KEYCHAIN_PASSPHRASE:-}}"
			if [ -z "$apple_email" ]; then
				echo "APPLE_EMAIL is required in $env_file." >&2
				exit 1
			fi
			if [ -z "$keychain_passphrase" ]; then
				echo "PASS or IPATOOL_KEYCHAIN_PASSPHRASE is required in $env_file." >&2
				exit 1
			fi
			"$IPATOOL_INSTALL_PATH" auth login \
				--email "$apple_email" \
				--keychain-passphrase "$keychain_passphrase"
			"$IPATOOL_INSTALL_PATH" auth info \
				--keychain-passphrase "$keychain_passphrase"
		'; then
		:
	else
		auth_status=$?
	fi

	if [ "$SERVICE_NEEDS_RESUME" = "1" ]; then
		echo "Restarting $SERVICE_NAME"
		if ! restore_active_service; then
			return 1
		fi
	fi
	return "$auth_status"
}

command_name="${1:-}"
case "$command_name" in
	upgrade)
		require_root "$@"
		upgrade "${2:-latest}"
		;;
	reauth)
		require_root "$@"
		reauth
		;;
	-h|--help|help)
		usage
		;;
	*)
		usage >&2
		exit 2
		;;
esac
