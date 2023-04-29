#!/bin/bash

# load UPLOAD_PASSWORD from .env file
if [ ! -f .env ]; then
  export $(cat .env | xargs)
fi

SERVER=http://localhost:3000
TEST_TIME=30
ANALYSIS_VERSION=2
UPLOAD_PASSWORD=

mkdir -p ipas
mkdir -p classes
mkdir -p analysis

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
	./helpers/ios_uninstall_all.sh
}

download()
{
	ipatool download -b $1 --purchase -o ./ipas/$1.ipa --non-interactive
}

sleepsixty()
{
	echo "Sleeping for 60s"
	sleep 10
	echo "Sleeping for 50s"
	sleep 10
	echo "Sleeping for 40s"
	sleep 10
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
			sleepsixty
			download $appId
		fi

		if [ ! -f "$f" ]; then
			echo "Download failed. Trying again.."
			sleepsixty
			download $appId
		fi

		if [ -f "$f" ]; then
	   		ideviceinstaller -i $f

			frida -U -f $appId -l ./helpers/find-all-classes.js > "classes/$appId-classes.txt" &
			PID2=$!
			sleep $TEST_TIME
			killwait $PID2
			ideviceinstaller -U $appId

			./static_analysis.py $appId
			curl -s "$SERVER/uploadAnalysis?password=$UPLOAD_PASSWORD&appId=$appId&analysisVersion=$ANALYSIS_VERSION" -d @analysis/$appId.json -H "Content-Type: application/json"
		fi

		if [ ! -f "analysis/$appId.json" ]; then
			curl -s "$SERVER/reportAnalysisFailure?password=$UPLOAD_PASSWORD&appId=$appId&analysisVersion=$ANALYSIS_VERSION"
		fi

		cleanup $appId
	fi

	sleepsixty
done

