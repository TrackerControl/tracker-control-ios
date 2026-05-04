#!/bin/bash

# make sure to be in correct working directory (e.g. if running from systemctl)
SCRIPTPATH="$( cd -- "$(dirname "$0")" >/dev/null 2>&1 ; pwd -P )"
cd $SCRIPTPATH

# load analyser settings from .env file
if [ -f .env ]; then
	set -a
	. ./.env
	set +a
fi

: "${FRIDA_PATH:=/home/pi/.local/bin}"
: "${SERVER:=http://localhost:3000}"
: "${TEST_TIME:=30}"
: "${ANALYSIS_VERSION:=3}"
: "${ANALYSIS_MODE:=trackerscan}"
: "${TRACKERSCAN_CMD:=ssh iphone trackerscan}"
: "${IPATOOL_KEYCHAIN_PASSPHRASE:=}"
: "${PASS:=$IPATOOL_KEYCHAIN_PASSPHRASE}"
: "${TIMEOUT:=300}"
: "${UPLOAD_PASSWORD:=}"
: "${APPLE_EMAIL:=}"
: "${APPLE_PASS:=}"
: "${MAX_DOWNLOAD_ATTEMPTS:=2}"
: "${MAX_DAILY_DOWNLOAD_BYTES:=50000000000}"
: "${MAX_APP_SIZE_BYTES:=3000000000}"
: "${MAX_ATTEMPT_DOWNLOAD_BYTES:=$MAX_APP_SIZE_BYTES}"
: "${CONSECUTIVE_FAILURE_LIMIT:=5}"
: "${CIRCUIT_BREAKER_SLEEP:=3600}"
: "${DOWNLOAD_WATCHDOG_INTERVAL:=5}"
: "${NETWORK_INTERFACE:=}"
: "${DAILY_BYTES_FILE:=./daily-download-bytes.txt}"
: "${RUN_ONCE:=0}"
: "${LIVE_LOG:=1}"
if [ -z "${COMPATIBLE_EXTENSION_POINTS:-}" ]; then
	COMPATIBLE_EXTENSION_POINTS="
		com.apple.action
		com.apple.AppSSO.idp-extension
		com.apple.AudioUnit-UI
		com.apple.authentication-services
		com.apple.authentication-services-account-authentication-modification-ui
		com.apple.authentication-services-credential-provider-ui
		com.apple.broadcast-services-setupui
		com.apple.broadcast-services-upload
		com.apple.callkit.call-directory
		com.apple.classkit.context-provider
		com.apple.document-provider
		com.apple.document-provider.file
		com.apple.fileprovider
		com.apple.fileprovider-actionsui
		com.apple.fileprovider-nonui
		com.apple.identitylookup.classification-ui
		com.apple.identitylookup.message-filter
		com.apple.intents-service
		com.apple.intents-ui-service
		com.apple.keyboard-service
		com.apple.message-payload-provider
		com.apple.networkextension.app-proxy
		com.apple.networkextension.app-push
		com.apple.networkextension.filter-control
		com.apple.networkextension.filter-data
		com.apple.networkextension.packet-tunnel
		com.apple.notificationcenter.widget
		com.apple.photo-editing
		com.apple.photo-project
		com.apple.quicklook.preview
		com.apple.quicklook.thumbnail
		com.apple.Safari.content-blocker
		com.apple.Safari.extension
		com.apple.services
		com.apple.share-services
		com.apple.sirikit.intents
		com.apple.sirikit.intentsui
		com.apple.spotlight.index
		com.apple.ui-services
		com.apple.usernotifications.content-extension
		com.apple.usernotifications.service
		com.apple.widget-extension
		com.apple.widgetkit-extension
	"
fi
SERVER="${SERVER%/}"
log="./processing.log"
daily_bytes_file="$DAILY_BYTES_FILE"
consecutive_failures=0

if [ -z "$UPLOAD_PASSWORD" ]; then
	echo "UPLOAD_PASSWORD is not set. Configure analyser/.env before starting the queue processor."
	exit 1
fi

mkdir -p ipas
mkdir -p classes
mkdir -p analysis
mkdir -p trackerscan

reset_daily_counter()
{
	today=$(date +%Y-%m-%d)
	if [ ! -f "$daily_bytes_file" ] || [ "$(head -n 1 "$daily_bytes_file" 2>/dev/null)" != "$today" ]; then
		printf "%s\n0\n" "$today" > "$daily_bytes_file"
	fi
}

get_daily_bytes()
{
	if [ -f "$daily_bytes_file" ]; then
		tail -n 1 "$daily_bytes_file"
	else
		echo 0
	fi
}

add_daily_bytes()
{
	bytes="$1"
	if [ -z "$bytes" ] || [ "$bytes" -le 0 ]; then
		return
	fi

	current=$(get_daily_bytes)
	total=$((current + bytes))
	printf "%s\n%s\n" "$(date +%Y-%m-%d)" "$total" > "$daily_bytes_file"
}

check_daily_limit()
{
	current=$(get_daily_bytes)
	if [ "$current" -ge "$MAX_DAILY_DOWNLOAD_BYTES" ]; then
		echo "Daily download limit reached: $((current / 1000000000)) GB. Pausing queue processor."
		return 1
	fi
	return 0
}

detect_network_interface()
{
	if [ -n "$NETWORK_INTERFACE" ]; then
		echo "$NETWORK_INTERFACE"
	elif command -v ip >/dev/null 2>&1; then
		ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n 1
	elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
		route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}'
	fi
}

get_rx_bytes()
{
	interface=$(detect_network_interface)
	if [ -n "$interface" ] && [ -r "/sys/class/net/$interface/statistics/rx_bytes" ]; then
		cat "/sys/class/net/$interface/statistics/rx_bytes"
	elif [ -n "$interface" ] && [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
		netstat -ibn -I "$interface" 2>/dev/null | awk -v iface="$interface" '$1 == iface && $3 ~ /^<Link/ {print $7; exit}'
	fi
}

file_size()
{
	stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || echo 0
}

format_bytes_mb()
{
	bytes="${1:-0}"
	echo "$((bytes / 1000000)) MB"
}

log_msg()
{
	if [ "$LIVE_LOG" = "1" ]; then
		echo "$*" | tee -a "$log"
	else
		echo "$*" >> "$log"
	fi
}

log_cmd()
{
	if [ "$LIVE_LOG" = "1" ]; then
		"$@" 2>&1 | tee -a "$log"
		return "${PIPESTATUS[0]}"
	fi

	"$@" >> "$log" 2>&1
}

plist_value_from_ipa()
{
	ipa="$1"
	plist_path="$2"
	plist_key="$3"
	tmp_plist=$(mktemp)

	if ! unzip -p "$ipa" "$plist_path" > "$tmp_plist" 2>/dev/null; then
		rm -f "$tmp_plist"
		return 1
	fi

	/usr/libexec/PlistBuddy -c "Print :$plist_key" "$tmp_plist" 2>/dev/null
	status=$?
	rm -f "$tmp_plist"
	return "$status"
}

extension_point_is_compatible()
{
	extension_point="$1"
	for allowed in $COMPATIBLE_EXTENSION_POINTS; do
		if [ "$extension_point" = "$allowed" ]; then
			return 0
		fi
	done
	return 1
}

incompatible_appex()
{
	ipa="$1"
	appId="$2"

	if ! command -v zipinfo >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1 || [ ! -x /usr/libexec/PlistBuddy ]; then
		echo "Skipping IPA preflight for $appId: zipinfo, unzip, or PlistBuddy is unavailable." >> "$log"
		return 1
	fi

	extension_plists=$(zipinfo -1 "$ipa" 2>/dev/null | grep '^Payload/.*\.app/Extensions/.*\.appex/Info.plist$' || true)
	for plist_path in $extension_plists; do
		extension_point=$(plist_value_from_ipa "$ipa" "$plist_path" "EXAppExtensionAttributes:EXExtensionPointIdentifier" \
			|| plist_value_from_ipa "$ipa" "$plist_path" "NSExtension:NSExtensionPointIdentifier" \
			|| echo "UNKNOWN")
		if ! extension_point_is_compatible "$extension_point"; then
			echo "$appId has app extension $plist_path with non-whitelisted extension point $extension_point." >> "$log"
			return 0
		fi
	done

	return 1
}

ideviceinstaller_has_commands()
{
	ideviceinstaller --help 2>&1 | grep -q "^COMMANDS:"
}

install_ipa()
{
	ipa="$1"
	if ideviceinstaller_has_commands; then
		ideviceinstaller install "$ipa"
	else
		ideviceinstaller -i "$ipa"
	fi
}

install_ipa_with_appinst()
{
	ipa="$1"
	if [ ! -x ./appinst.sh ]; then
		echo "appinst fallback requested, but ./appinst.sh is not executable."
		return 1
	fi

	COMPATIBLE_EXTENSION_POINTS="$COMPATIBLE_EXTENSION_POINTS" ./appinst.sh "$ipa"
}

uninstall_app()
{
	bundle_id="$1"
	if ideviceinstaller_has_commands; then
		ideviceinstaller uninstall "$bundle_id"
	else
		ideviceinstaller -U "$bundle_id"
	fi
}

killwait ()
{
	(sleep 1; kill $1) &
	wait $1
}

cleanup()
{
	rm -f "classes/$1-classes.txt"
	rm -f "analysis/$1.json"
	rm -f "trackerscan/$1.json"
	rm -f "ipas/$1.ipa"
	rm -f ipas/*.tmp
	./helpers/ios_uninstall_all.sh
}

show_log_tail()
{
	lines="${1:-80}"
	if [ -s "$log" ]; then
		echo "--- recent processing log ---"
		tail -n "$lines" "$log"
		echo "--- end processing log ---"
	fi
}

report_analysis_failure()
{
	appId="$1"
	curl -sS --fail "$SERVER/reportAnalysisFailure?password=$UPLOAD_PASSWORD&appId=$appId&analysisVersion=$ANALYSIS_VERSION" --data-binary "@$log" -H "Content-Type: text/plain" > /dev/null
}

upload_analysis()
{
	appId="$1"
	curl -sS --fail "$SERVER/uploadAnalysis?password=$UPLOAD_PASSWORD&appId=$appId&analysisVersion=$ANALYSIS_VERSION" -d @"analysis/$appId.json" -H "Content-Type: application/json" > /dev/null
}

download()
{
	# ipatool's combined download path handles already-owned apps and purchases.
	appId="$1"
	rx_start=$(get_rx_bytes)
	daily_start=$(get_daily_bytes)
	start_time=$(date +%s)

	download_cmd=(ipatool download -b "$appId" --purchase -o "./ipas/$appId.ipa" --non-interactive)
	if [ -n "$PASS" ]; then
		download_cmd+=(--keychain-passphrase "$PASS")
	fi

	"${download_cmd[@]}" >> "$log" 2>&1 &
	pid=$!

	while kill -0 "$pid" 2>/dev/null; do
		sleep "$DOWNLOAD_WATCHDOG_INTERVAL"
		now=$(date +%s)

		if [ $((now - start_time)) -ge "$TIMEOUT" ]; then
			echo "Aborting $appId download after TIMEOUT=$TIMEOUT seconds." >> "$log"
			kill "$pid" 2>/dev/null
			if command -v pkill >/dev/null 2>&1; then
				pkill -TERM -P "$pid" 2>/dev/null || true
			fi
			wait "$pid" 2>/dev/null
			return 124
		fi

		rx_now=$(get_rx_bytes)
		if [ -n "$rx_start" ] && [ -n "$rx_now" ] && [ "$rx_now" -ge "$rx_start" ]; then
			bytes=$((rx_now - rx_start))
			if [ "$bytes" -ge "$MAX_ATTEMPT_DOWNLOAD_BYTES" ]; then
				echo "Aborting $appId download after $((bytes / 1000000)) MB received in one attempt." >> "$log"
				kill "$pid" 2>/dev/null
				if command -v pkill >/dev/null 2>&1; then
					pkill -TERM -P "$pid" 2>/dev/null || true
				fi
				wait "$pid" 2>/dev/null
				return 124
			fi

			if [ $((daily_start + bytes)) -ge "$MAX_DAILY_DOWNLOAD_BYTES" ]; then
				echo "Aborting $appId download because the daily cap would be reached at $(((daily_start + bytes) / 1000000000)) GB." >> "$log"
				kill "$pid" 2>/dev/null
				if command -v pkill >/dev/null 2>&1; then
					pkill -TERM -P "$pid" 2>/dev/null || true
				fi
				wait "$pid" 2>/dev/null
				return 124
			fi
		fi
	done

	wait "$pid"
}

download_attempt()
{
	appId="$1"
	f="./ipas/$appId.ipa"
	rx_before=$(get_rx_bytes)

	download "$appId"
	status=$?

	rx_after=$(get_rx_bytes)
	if [ -n "$rx_before" ] && [ -n "$rx_after" ] && [ "$rx_after" -ge "$rx_before" ]; then
		bytes=$((rx_after - rx_before))
		add_daily_bytes "$bytes"
		echo "Network received during ipatool attempt: $(format_bytes_mb "$bytes") (daily total: $(format_bytes_mb "$(get_daily_bytes)"))"
	elif [ -f "$f" ]; then
		bytes=$(file_size "$f")
		add_daily_bytes "$bytes"
		echo "Downloaded IPA size: $(format_bytes_mb "$bytes") (daily total: $(format_bytes_mb "$(get_daily_bytes)"))"
	else
		echo "Could not measure ipatool network usage on this system."
	fi

	return "$status"
}

relogin()
{
	if [ -n "$APPLE_EMAIL" ] && [ -n "$APPLE_PASS" ]; then
		login_cmd=(ipatool auth login --email "$APPLE_EMAIL" --password "$APPLE_PASS")
		if [ -n "$PASS" ]; then
			login_cmd+=(--keychain-passphrase "$PASS")
		fi
		log_cmd "${login_cmd[@]}"
	else
		log_msg "APPLE_EMAIL/APPLE_PASS not set; keeping existing ipatool session."
	fi
}

run_trackerscan()
{
	appId="$1"
	out="trackerscan/$appId.json"
	if [ "$LIVE_LOG" = "1" ]; then
		sh -c "$TRACKERSCAN_CMD \"\$1\"" sh "$appId" > "$out" 2> >(tee -a "$log" >&2)
	else
		sh -c "$TRACKERSCAN_CMD \"\$1\"" sh "$appId" > "$out" 2>> "$log"
	fi
}

analyse_installed_app()
{
	appId="$1"
	ipa="${2:-}"

	case "$ANALYSIS_MODE" in
		trackerscan)
			run_trackerscan "$appId"
			log_cmd node ./trackerscan_to_analysis.js "$appId" "trackerscan/$appId.json" "analysis/$appId.json" "$ipa"
			;;
		frida)
			$FRIDA_PATH/frida -U -f "$appId" -l ./helpers/find-all-classes.js > "classes/$appId-classes.txt" 2>> "$log" &
			PID2=$!
			sleep "$TEST_TIME"
			killwait "$PID2"
			log_cmd ./static_analysis.py "$appId"
			;;
		*)
			log_msg "Unknown ANALYSIS_MODE=$ANALYSIS_MODE. Use trackerscan or frida."
			return 2
			;;
	esac
}

sleepabit()
{
	echo "Sleeping for 30s"
	sleep 10
	echo "Sleeping for 20s"
	sleep 10
	echo "Sleeping for 10s"
	sleep 10
}

counter_self_test()
{
	old_daily_limit="$MAX_DAILY_DOWNLOAD_BYTES"

	reset_daily_counter
	add_daily_bytes 1234
	if [ "$(get_daily_bytes)" != "1234" ]; then
		echo "Counter self-test failed after first increment."
		return 1
	fi

	add_daily_bytes 66
	if [ "$(get_daily_bytes)" != "1300" ]; then
		echo "Counter self-test failed after second increment."
		return 1
	fi

	MAX_DAILY_DOWNLOAD_BYTES=1300
	if check_daily_limit; then
		echo "Counter self-test failed to detect daily cap."
		MAX_DAILY_DOWNLOAD_BYTES="$old_daily_limit"
		return 1
	fi
	MAX_DAILY_DOWNLOAD_BYTES="$old_daily_limit"

	echo "Counter self-test passed."
}

download_self_test()
{
	appId="$DOWNLOAD_SELF_TEST_BUNDLE_ID"
	f="./ipas/$appId.ipa"

	reset_daily_counter
	> "$log"
	rm -f "$f"
	rm -f ipas/*.tmp

	echo "Download self-test for $appId"
	echo "Interface: $(detect_network_interface)"
	echo "RX before: $(get_rx_bytes)"
	download_attempt "$appId"
	status=$?
	echo "RX after: $(get_rx_bytes)"
	echo "Daily counter: $(get_daily_bytes)"

	if [ -f "$f" ]; then
		echo "IPA exists after self-test: $(file_size "$f") bytes"
	else
		echo "No IPA exists after self-test."
	fi

	rm -f "$f"
	rm -f ipas/*.tmp
	return "$status"
}

if [ "$COUNTER_SELF_TEST" = "1" ]; then
	counter_self_test
	exit $?
fi

if [ -n "$DOWNLOAD_SELF_TEST_BUNDLE_ID" ]; then
	download_self_test
	exit $?
fi

while true; do
	reset_daily_counter

	echo "Reporting online status apps to install"
	curl -s "$SERVER/ping?password=$UPLOAD_PASSWORD"

	if ! check_daily_limit; then
		sleep "$CIRCUIT_BREAKER_SLEEP"
		continue
	fi

	if [ "$consecutive_failures" -ge "$CONSECUTIVE_FAILURE_LIMIT" ]; then
		echo "Circuit breaker tripped after $consecutive_failures consecutive failures. Sleeping for $CIRCUIT_BREAKER_SLEEP seconds."
		sleep "$CIRCUIT_BREAKER_SLEEP"
		consecutive_failures=0
		continue
	fi

	echo "Fetching apps to install"
	appId=`curl -s "$SERVER/queue?password=$UPLOAD_PASSWORD" --fail`

	if [ "$appId" == "" ] ; then
	   echo "No app to process.."
	else
		# empty the log file
		> $log
		rm -f "classes/$appId-classes.txt"
		rm -f "analysis/$appId.json"
		rm -f "trackerscan/$appId.json"

		echo "Downloading app $appId"
		f=./ipas/$appId.ipa
		attempt=1

		while [ "$attempt" -le "$MAX_DOWNLOAD_ATTEMPTS" ] && [ ! -f "$f" ]; do
			if ! check_daily_limit; then
				break
			fi

			echo "Download attempt $attempt/$MAX_DOWNLOAD_ATTEMPTS for $appId"
			download_attempt "$appId"

			if [ -f "$f" ]; then
				break
			fi

			attempt=$((attempt + 1))
			if [ "$attempt" -le "$MAX_DOWNLOAD_ATTEMPTS" ]; then
				echo "Download failed. Retrying after a short pause."
				sleepabit
				relogin
				sleep 10
			fi
		done

		if [ -f "$f" ]; then
			size=$(file_size "$f")
			if [ "$size" -gt "$MAX_APP_SIZE_BYTES" ]; then
				echo "Skipping $appId: downloaded IPA is $((size / 1000000)) MB, above MAX_APP_SIZE_BYTES=$((MAX_APP_SIZE_BYTES / 1000000)) MB." >> "$log"
				show_log_tail
				if report_analysis_failure "$appId"; then
					echo "Reported analysis failure for $appId."
				else
					echo "Failed to report analysis failure for $appId."
				fi
				cleanup $appId
				if [ "$RUN_ONCE" = "1" ]; then
					exit 0
				fi
				sleepabit
				continue
			fi

			if incompatible_appex "$f" "$appId"; then
				log_msg "Installing $appId with appinst fallback."
				install_cmd=install_ipa_with_appinst
			else
				install_cmd=install_ipa
			fi

			if log_cmd "$install_cmd" "$f"; then
				analyse_installed_app "$appId" "$f"
				log_cmd uninstall_app "$appId"
			else
				log_msg "Installing $appId failed."
			fi

			if [ -f "analysis/$appId.json" ]; then
				if [ "$RUN_ONCE" = "1" ] && [ "$LIVE_LOG" != "1" ]; then
					show_log_tail
				fi
				if upload_analysis "$appId"; then
					echo "Uploaded analysis for $appId."
					consecutive_failures=0
				else
					echo "Failed to upload analysis for $appId."
				fi
			fi
		fi

		if [ ! -f "analysis/$appId.json" ]; then
			show_log_tail
			if report_analysis_failure "$appId"; then
				echo "Reported analysis failure for $appId."
			else
				echo "Failed to report analysis failure for $appId."
			fi
			consecutive_failures=$((consecutive_failures + 1))
			echo "Consecutive failures: $consecutive_failures/$CONSECUTIVE_FAILURE_LIMIT"
		fi

		cleanup $appId
	fi

	if [ "$RUN_ONCE" = "1" ]; then
		exit 0
	fi

	sleepabit
done
