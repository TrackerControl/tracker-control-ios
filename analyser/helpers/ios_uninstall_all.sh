#!/bin/bash

ideviceinstaller -l | cut -d, -f1 | tail -n +2 | while read -r line ; do
    if [ "$line" == "com.spotify.client" ]; then
       continue
    fi
    
    if [ "$line" == "science.xnu.undecimus" ]; then
       continue
    fi

    if [ "$line" == "com.google.Maps" ]; then
       continue
    fi

    ideviceinstaller -U $line
done
