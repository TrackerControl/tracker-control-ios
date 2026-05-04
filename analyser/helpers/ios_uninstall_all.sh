#!/bin/bash

ideviceinstaller_has_commands()
{
	ideviceinstaller --help 2>&1 | grep -q "^COMMANDS:"
}

list_installed_apps()
{
	if ideviceinstaller_has_commands; then
		ideviceinstaller list
	else
		ideviceinstaller -l
	fi
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

list_installed_apps | cut -d, -f1 | tail -n +2 | while read -r line ; do
    if [ "$line" == "com.spotify.client" ]; then
       continue
    fi
    
    if [ "$line" == "science.xnu.undecimus" ]; then
       continue
    fi

    if [ "$line" == "com.google.Maps" ]; then
       continue
    fi

    uninstall_app "$line"
done
