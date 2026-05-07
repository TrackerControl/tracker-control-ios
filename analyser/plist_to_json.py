#!/usr/bin/env python3
import base64
import datetime
import json
import plistlib
import sys


def normalize(value):
    if isinstance(value, dict):
        return {str(key): normalize(child) for key, child in value.items()}
    if isinstance(value, list):
        return [normalize(child) for child in value]
    if isinstance(value, bytes):
        return {"$base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    return value


def main():
    if len(sys.argv) != 2:
        print("Usage: plist_to_json.py <Info.plist>", file=sys.stderr)
        return 2

    with open(sys.argv[1], "rb") as handle:
        plist = plistlib.load(handle)

    print(json.dumps(normalize(plist), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
