#!/bin/bash

# make sure to be in correct working directory (e.g. if running from systemctl)
SCRIPTPATH="$( cd -- "$(dirname "$0")" >/dev/null 2>&1 ; pwd -P )"
cd $SCRIPTPATH

# load UPLOAD_PASSWORD from .env file
if [ ! -f .env ]; then
  export $(cat .env | xargs)
fi

FRIDA_PATH=/home/pi/.local/bin
SERVER=http://localhost:3000
TEST_TIME=30
ANALYSIS_VERSION=2
PASS=1
TIMEOUT=300
UPLOAD_PASSWORD=
APPLE_EMAIL=
APPLE_PASS=
log="./processing.log"

# Bandwidth safeguards
MAX_APP_SIZE_MB=2000             # Skip IPAs larger than 2 GB
MAX_DAILY_DOWNLOAD_BYTES=50000000000  # 50 GB daily limit
CONSECUTIVE_FAILURE_LIMIT=5      # Pause queue after N consecutive failures
daily_bytes_file="./daily_bytes.txt"
consecutive_failures=0

mkdir -p ipas
mkdir -p classes
mkdir -p analysis

# Reset daily download counter if it's a new day
reset_daily_counter()
{
	today=$(date +%Y-%m-%d)
	if [ -f "$daily_bytes_file" ]; then
		stored_date=$(head -1 "$daily_bytes_file")
		if [ "$stored_date" != "$today" ]; then
			echo "$today" > "$daily_bytes_file"
			echo "0" >> "$daily_bytes_file"
		fi
	else
		echo "$today" > "$daily_bytes_file"
		echo "0" >> "$daily_bytes_file"
	fi
}

get_daily_bytes()
{
	if [ -f "$daily_bytes_file" ]; then
		tail -1 "$daily_bytes_file"
	else
		echo "0"
	fi
}

add_daily_bytes()
{
	current=$(get_daily_bytes)
	new_total=$((current + $1))
	today=$(date +%Y-%m-%d)
	echo "$today" > "$daily_bytes_file"
	echo "$new_total" >> "$daily_bytes_file"
}

check_bandwidth_limit()
{
	current=$(get_daily_bytes)
	if [ "$current" -ge "$MAX_DAILY_DOWNLOAD_BYTES" ]; then
		echo "Daily download limit reached ($(($current / 1000000000)) GB). Pausing until tomorrow."
		return 1
	fi
	return 0
}

killwait ()
{
	(sleep 1; kill $1) &
	wait $1
}

cleanup()
{
	rm classes/$1-classes.txt
	rm analysis/$1.json
	rm ipas/$1.ipa
	rm ipas/*.tmp
	./helpers/ios_uninstall_all.sh
}

download()
{
	timeout $TIMEOUT ipatool download -b $1 --purchase -o ./ipas/$1.ipa --non-interactive --keychain-passphrase $PASS >> $log 2>&1
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

while true; do
	reset_daily_counter

	echo "Reporting online status apps to install"
	curl -s "$SERVER/ping?password=$UPLOAD_PASSWORD"

	# Check bandwidth limit before fetching next app
	if ! check_bandwidth_limit; then
		sleepabit
		continue
	fi

	# Check consecutive failure circuit breaker
	if [ "$consecutive_failures" -ge "$CONSECUTIVE_FAILURE_LIMIT" ]; then
		echo "Circuit breaker: $consecutive_failures consecutive failures. Pausing for 10 minutes."
		sleep 600
		consecutive_failures=0
		continue
	fi

	echo "Fetching apps to install"
	appId=`curl -s "$SERVER/queue" --fail`

	if [ "$appId" == "" ] ; then
	   echo "No app to process.."
	else
 		# empty the log file
   		> $log

		echo "Downloading app $appId"
		f=./ipas/$appId.ipa
		download $appId

		if [ ! -f "$f" ]; then
			echo "Download failed. Trying again.."
			sleepabit
			download $appId
		fi

		if [ ! -f "$f" ]; then
			echo "Download failed. Trying again.."
			sleepabit
			ipatool auth login --email $APPLE_EMAIL  --keychain-passphrase 1 --password $APPLE_PASS
			sleep 10
			download $appId
		fi

		if [ -f "$f" ]; then
			# Track downloaded bytes
			file_size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0)
			add_daily_bytes "$file_size"
			echo "Downloaded $appId: $(($file_size / 1000000)) MB (daily total: $(($(get_daily_bytes) / 1000000000)) GB)"

			# Skip oversized apps
			file_size_mb=$(($file_size / 1000000))
			if [ "$file_size_mb" -gt "$MAX_APP_SIZE_MB" ]; then
				echo "Skipping $appId: ${file_size_mb} MB exceeds ${MAX_APP_SIZE_MB} MB limit"
				echo "App too large (${file_size_mb} MB)" > $log
				curl -s "$SERVER/reportAnalysisFailure?password=$UPLOAD_PASSWORD&appId=$appId&analysisVersion=$ANALYSIS_VERSION" --data-binary "@$log" -H "Content-Type: text/plain"
				cleanup $appId
				sleepabit
				continue
			fi

	   		ideviceinstaller -i $f >> $log 2>&1

			$FRIDA_PATH/frida -U -f $appId -l ./helpers/find-all-classes.js > "classes/$appId-classes.txt" 2>> $log &
			PID2=$!
			sleep $TEST_TIME
			killwait $PID2
			ideviceinstaller -U $appId >> $log 2>&1

			./static_analysis.py $appId >> $log 2>&1
			curl -s "$SERVER/uploadAnalysis?password=$UPLOAD_PASSWORD&appId=$appId&analysisVersion=$ANALYSIS_VERSION" -d @analysis/$appId.json -H "Content-Type: application/json"

			consecutive_failures=0
		fi

		if [ ! -f "analysis/$appId.json" ]; then
   			curl -s "$SERVER/reportAnalysisFailure?password=$UPLOAD_PASSWORD&appId=$appId&analysisVersion=$ANALYSIS_VERSION" --data-binary "@$log" -H "Content-Type: text/plain"
			consecutive_failures=$((consecutive_failures + 1))
			echo "Consecutive failures: $consecutive_failures / $CONSECUTIVE_FAILURE_LIMIT"
		fi

		cleanup $appId
	fi

	sleepabit
done

