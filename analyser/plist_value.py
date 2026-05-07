#!/usr/bin/env python3
import json
import plistlib
import sys


def read_path(value, key_path):
    current = value
    for part in key_path.strip(":").split(":"):
        if not part:
            continue
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def main():
    if len(sys.argv) < 3:
        print("Usage: plist_value.py <Info.plist> <key:path> [<key:path>...]", file=sys.stderr)
        return 2

    with open(sys.argv[1], "rb") as handle:
        plist = plistlib.load(handle)

    for key_path in sys.argv[2:]:
        value = read_path(plist, key_path)
        if value is None:
            continue
        if isinstance(value, (dict, list)):
            print(json.dumps(value, separators=(",", ":")))
        else:
            print(value)
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
