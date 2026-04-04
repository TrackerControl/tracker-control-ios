#!/usr/bin/env python3
"""
Analyse captured network traffic (HAR files) to identify tracker domains.

Reads a HAR file captured by mitmproxy during app runtime and matches
contacted domains against known tracker domains. Outputs a JSON summary
of tracker vs non-tracker network activity.

Usage: ./traffic_analysis.py <appId>
  Expects: traffic/<appId>.har
  Outputs: traffic/<appId>-traffic.json
"""

import json
import sys
import os
from urllib.parse import urlparse

if len(sys.argv) == 1:
    print("Please provide appId")
    sys.exit(1)

appId = sys.argv[1]
har_path = "traffic/" + appId + ".har"
out_path = "traffic/" + appId + "-traffic.json"

# Load tracker domain database
with open('data/tracker_domains.json', encoding='utf-8') as fh:
    tracker_db = json.load(fh)['domains']


def match_domain(hostname):
    """Match a hostname against known tracker domains.

    Checks exact match first, then progressively strips subdomains.
    E.g. for 'sdk.graph.facebook.com', checks:
      sdk.graph.facebook.com -> graph.facebook.com -> facebook.com
    """
    parts = hostname.lower().split('.')
    for i in range(len(parts)):
        candidate = '.'.join(parts[i:])
        if candidate in tracker_db:
            return tracker_db[candidate]
    return None


def analyse_har(har_path):
    """Extract contacted domains from a HAR file and classify them."""
    with open(har_path, 'r') as f:
        har = json.load(f)

    contacted_domains = {}

    # Process HTTP entries (requests that completed)
    for entry in har.get('log', {}).get('entries', []):
        request = entry.get('request', {})
        host = request.get('host', '')
        url = request.get('url', '')

        if not host and url:
            try:
                host = urlparse(url).hostname or ''
            except Exception:
                continue

        if not host:
            continue

        host = host.lower()
        if host not in contacted_domains:
            contacted_domains[host] = {
                'count': 0,
                'first_seen': entry.get('startedDateTime', ''),
            }
        contacted_domains[host]['count'] += 1

    # Process raw domain connections (includes non-HTTP like TLS without MITM)
    for conn in har.get('log', {}).get('domains', []):
        hostname = conn.get('hostname', '')
        if not hostname:
            continue
        hostname = hostname.lower()
        if hostname not in contacted_domains:
            contacted_domains[hostname] = {
                'count': 1,
                'first_seen': conn.get('timestamp', ''),
            }

    # Classify domains
    tracker_domains = {}
    other_domains = {}
    system_domains = {}

    for domain, info in contacted_domains.items():
        match = match_domain(domain)
        if match:
            if '_system' in match.get('categories', []):
                system_domains[domain] = {
                    'name': match['name'],
                    'count': info['count'],
                }
            else:
                tracker_domains[domain] = {
                    'name': match['name'],
                    'categories': match.get('categories', []),
                    'count': info['count'],
                    'first_seen': info.get('first_seen', ''),
                }
        else:
            other_domains[domain] = {
                'count': info['count'],
            }

    return {
        'tracker_domains': tracker_domains,
        'other_domains': other_domains,
        'system_domains': system_domains,
        'total_domains': len(contacted_domains),
        'total_tracker_domains': len(tracker_domains),
    }


if not os.path.exists(har_path):
    print(f"No HAR file found at {har_path}")
    # Output empty result so pipeline doesn't fail
    result = {
        'tracker_domains': {},
        'other_domains': {},
        'system_domains': {},
        'total_domains': 0,
        'total_tracker_domains': 0,
    }
else:
    result = analyse_har(har_path)

os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, 'w') as f:
    json.dump(result, f)

print(f"Traffic analysis: {result['total_tracker_domains']} tracker domains "
      f"out of {result['total_domains']} total domains contacted")
