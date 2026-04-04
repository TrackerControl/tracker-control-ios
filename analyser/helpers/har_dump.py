"""
mitmproxy addon that saves traffic to a HAR (HTTP Archive) file.
Based on the mitmproxy built-in har_dump addon.

Usage: mitmdump -p 8888 -s har_dump.py --set hardump=./output.har
"""

import json
import base64
import typing
from datetime import datetime, timezone

from mitmproxy import ctx, http, connection


class HarDump:
    def __init__(self):
        self.har: dict = {
            "log": {
                "version": "1.2",
                "creator": {"name": "tracker-control-ios", "version": "1.0"},
                "entries": [],
                "domains": [],
            }
        }

    def load(self, loader):
        loader.add_option(
            "hardump", str, "", "HAR dump file path."
        )

    def response(self, flow: http.HTTPFlow):
        entry = {
            "startedDateTime": datetime.now(timezone.utc).isoformat(),
            "request": {
                "method": flow.request.method,
                "url": flow.request.url,
                "host": flow.request.host,
                "port": flow.request.port,
            },
            "response": {
                "status": flow.response.status_code if flow.response else 0,
            },
            "serverIPAddress": flow.server_conn.peername[0] if flow.server_conn and flow.server_conn.peername else "",
        }
        self.har["log"]["entries"].append(entry)

    def server_connect(self, data: connection.ServerConnectionHookData):
        conn = data.server
        if conn.peername:
            domain_entry = {
                "address": conn.peername[0],
                "port": conn.peername[1],
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            if conn.address:
                domain_entry["hostname"] = conn.address[0]
            self.har["log"]["domains"].append(domain_entry)

    def done(self):
        dump_file = ctx.options.hardump
        if dump_file:
            with open(dump_file, "w") as f:
                json.dump(self.har, f, indent=2)
            ctx.log.info(f"HAR dump saved to {dump_file}")


addons = [HarDump()]
