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

mkdir -p ipas
mkdir -p classes
mkdir -p analysis

# create empty log file
log="./processing.log"
> $log

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
	echo "Reporting online status apps to install"
	curl -s "$SERVER/ping?password=$UPLOAD_PASSWORD"

	echo "Fetching apps to install"
	appId=`curl -s "$SERVER/queue" --fail`

	if [ "$appId" == "" ] ; then
	   echo "No app to process.."
	else
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
	   		ideviceinstaller -i $f >> $log 2>&1

			$FRIDA_PATH/frida -U -f $appId -l ./helpers/find-all-classes.js > "classes/$appId-classes.txt" 2>> $log &
			PID2=$!
			sleep $TEST_TIME
			killwait $PID2
			ideviceinstaller -U $appId >> $log 2>&1

			./static_analysis.py $appId >> $log 2>&1
			curl -s "$SERVER/uploadAnalysis?password=$UPLOAD_PASSWORD&appId=$appId&analysisVersion=$ANALYSIS_VERSION" -d @analysis/$appId.json -H "Content-Type: application/json"
		fi

		if [ ! -f "analysis/$appId.json" ]; then
   			curl -s "$SERVER/reportAnalysisFailure?password=$UPLOAD_PASSWORD&appId=$appId&analysisVersion=$ANALYSIS_VERSION" --data-binary "@$log" -H "Content-Type: text/plain"
		fi

		cleanup $appId
	fi

	sleepabit
done

