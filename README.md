# TrackerControl for iOS

This repository provides the code for a tracker analysis tool for iOS. It is inspired by the existing [TrackerControl app for Android](https://trackercontrol.org).

## Getting started

Start the server with `npm run watch` (during development) or `npm run start` (for production).

You also need to set up a server to run the script `analyser/processQueue.sh`. This server, in turn, will need to be connected to a jailbroken iPhone that runs Frida. The iPhone should be configured such that the display is always on.

## Credits
- Oxford SOCIAM Project: <https://sociam.org/mobile-app-x-ray>
- PlatformControl: <https://www.platformcontrol.org>
- Exodus Privacy: <https://exodus-privacy.eu.org/>
- frida-ios-hook: <https://github.com/noobpk/frida-ios-hook>
