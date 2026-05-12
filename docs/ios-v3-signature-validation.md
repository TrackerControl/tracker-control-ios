# iOS v3 Tracker Signature Validation

This document records the current v3 iOS tracker signature set, its provenance,
the conservative promotion rules, and the remaining caveats.

## Scope

The v3 work is an offline signature/data refresh. It does not require analyser
or converter runtime changes. The intended next step is to replay signatures
against stored `__ALL_CLASSES__` dumps rather than re-installing apps on device.

## Artifacts

- `analyser/data/ios_signatures_v3.json`: lean runtime signature set for
  scanning/replay.
- `analyser/data/ios_signatures_v3.metadata.json`: curation notes, evidence,
  and validation metadata keyed to the runtime signatures.
- `analyser/data/ios_signatures_v3.summary.json`: generation summary,
  provenance, promotion rules, and decisions.
- `analyser/data/ios_signatures_v3.validation.json`: offline validation
  against stored `trackerscan` class-dump artifacts.
- `scripts/build-ios-v3-signatures.js`: deterministic builder from v2 to v3.
- `scripts/validate-ios-v3-signatures.js`: offline validator that replays a
  signature file against raw `*.trackerscan.json` artifacts containing
  `__ALL_CLASSES__`.
- `scripts/audit-ios-v3-signatures.js`: repo-local quality gate for provenance,
  exposure flags, duplicate cleanup, validation metadata, display gating, and
  documentation coverage.

The local workbook `analyser/data/ios-v2-signature-review.xlsx` contains an
audit sheet view of the same outcomes, but is intentionally excluded from
commits. It records automated decisions only.

## Provenance

v3 is generated from `analyser/data/ios_signatures_v2.json`. The v2 signature
data and analyser integration are on branch `ios-v2-analyser`; the CocoaPods
and class-evidence generation method is documented on branch
`ios-class-evidence-refactor`, especially:

- `tracker-db-mvp/bin/build-ios-signatures-v2.js`
- `tracker-db-mvp/bin/mirror-cocoapods-metadata.js`
- `tracker-db-mvp/bin/inspect-pod-headers.js`
- `tracker-db-mvp/bin/validate-signatures-against-classes.js`

The v2 inputs were ETIP/Exodus tracker metadata, CocoaPods metadata and header
inspection, SwiftPM/GitHub package metadata where available, and app corpus
class dumps from `trackerscan --signatures ... __ALL_CLASSES__`.

v3 also mines the stored `__ALL_CLASSES__` dumps directly. This is used to find
new class anchors for domain-disclosed trackers that v1/v2 missed, such as
modern Braze/BrazeKit classes and PubMatic/OpenWrap/OMIDPubmatic classes.

## Promotion Rules

- Keep legacy v1 tracker signatures visible for continuity.
- Merge duplicate `- v2 refined` signatures into canonical v1 names.
- Promote a new v3 signature only when class anchors are vendor-specific and
  either tracking domains corroborate the tracker or repeated corpus evidence is
  low-noise SDK-core evidence.
- Keep mediation-only, generic-word, or ambiguous evidence hidden.
- Keep noisy signatures in v3 only for offline evidence collection.

## Current Counts

As of the current validation run:

- total signatures: 330
- visible signatures: 121
- hidden signatures: 198
- non-tracker/support signatures: 10
- instrumentation signatures: 1
- raw artifacts inspected: 830
- full class dumps replayed: 818

## Delta Versus v1

Using the same 818 full class dumps, v3 visible signatures add substantial
coverage over the old visible v1 tracker set:

- v1 visible detections: 5268
- v3 visible detections: 6191
- net gain: 923 detections
- apps with additional detections: 337
- apps with fewer detections: 0

The largest gains are Amazon Advertisement (+168 apps), BidMachine (+108),
PubNative (+102), Ogury Presage (+87), HyprMX (+72), myTarget (+69), PubMatic
(+40), Braze (+38), HelpShift (+32), OneSignal (+31), and Singular (+29).

## Promoted New v3 Signatures

| Tracker | Apps | Matches | Confidence | Risk | Notes |
| --- | ---: | ---: | --- | --- | --- |
| AdTiming | 2 | 4 | medium-high | low-medium | AdTiming-specific SDK manager namespaces. |
| BidMachine | 108 | 536 | medium-high | medium | Vendor-specific direct delegate and mediation adapter classes. |
| Chartbeat | 8 | 8 | medium-high | low-medium | Direct Chartbeat configuration namespace. |
| Countly | 5 | 101 | high | low | Direct Countly SDK namespaces; generic contains-Countly matches excluded. |
| Criteo | 3 | 15 | high | low | Criteo Publisher SDK namespaces. |
| Dynatrace | 10 | 33 | high | low | Direct Dynatrace SDK namespaces. |
| HelpShift | 32 | 218 | high | low | Direct Helpshift SDK namespaces. |
| HyprMX | 72 | 360 | medium-high | low-medium | Vendor-specific placement delegates and bridge classes. |
| Instabug | 13 | 179 | high | low-medium | Direct Instabug SDK namespaces; generic `IBGRepro` evidence remains hidden. |
| KIDOZ | 2 | 15 | high | low | KidozSDK ad delegate namespaces. |
| LeanPlum | 15 | 42 | high | low | Direct Leanplum SDK namespaces. |
| Nielsen | 9 | 9 | high | low | NielsenAppSDK namespace with `imrworldwide.com` domain corroboration. |
| Ogury Presage | 87 | 2829 | high | low-medium | Direct Ogury ad delegates, OMID namespaces, and bridge classes. |
| OneSignal | 31 | 1086 | high | low | Direct OneSignal SDK, notification, receipt, IAP, and analytics bridge classes. |
| OutBrain | 1 | 3 | medium-high | medium | Direct Outbrain classes in one domain-disclosing app; other Outbrain-domain apps remain gaps. |
| Pendo | 3 | 44 | high | low | Direct Pendo SDK namespaces. |
| PubMatic | 40 | 11937 | high | low-medium | PubMatic/OpenWrap/OMIDPubmatic namespaces with `oi-ow.pubmatic.com` corroboration. |
| PubNative | 102 | 2938 | medium-high | medium | PubNative-specific OMID and bridge classes; prefix-only matching avoids MoPubNative false positives. |
| Pushwoosh | 2 | 7 | high | low | Direct Pushwoosh SDK namespaces. |
| Rollbar | 3 | 317 | high | low | Direct Rollbar SDK namespaces. |
| Segment | 7 | 13 | high | low | Known Segment iOS `SEGAnalytics` namespace. |
| Singular | 29 | 291 | high | low | Direct Singular attribution SDK classes; `safetrack*.singular.net` corroborates most domain-disclosing apps. |
| Tappx | 2 | 286 | high | low | Tappx SDK and OMID namespaces. |
| Tenjin | 1 | 8 | high | low | Direct Tenjin SDK namespaces with `track.tenjin.com` corroboration. |
| UXCam | 4 | 207 | high | low | Direct UXCam SDK namespaces. |
| mParticle | 14 | 236 | high | low-medium | Direct MPKit/mParticle namespaces; broad contains-mParticle matches excluded. |

## Refined Legacy Signatures

| Tracker | Apps | Matches | Confidence | Risk | Change |
| --- | ---: | ---: | --- | --- | --- |
| Adobe Experience Cloud | 11 | 30 | high | low | Merged duplicate legacy `ADBMobile` and AEP SDK anchors into one canonical visible signature. |
| Amazon Advertisement | 189 | 6725 | high | low | Merged Amazon Publisher Services/DTB refinement into the canonical v1 name. |
| AppMetrica | 30 | 3024 | high | low | Merged modern `AMAAppMetrica` and Yandex AppMetrica anchors. |
| Braze (formerly Appboy) | 64 | 1244 | high | low | Expanded legacy `Appboy` with modern Braze/BrazeKit/BrazeUI anchors mined from domain-disclosing class dumps. |
| Mintegral | 129 | 6989 | high | low-medium | Merged direct MTG SDK/ad-unit anchors and explicit adapter anchors. |
| myTarget | 81 | 1130 | high | low | Merged direct `MTRG*` and bridge evidence into canonical v1 name. |

## Domain Cross-Validation

Domain cross-validation is opportunistic. Apple privacy manifests do not expose
every embedded tracker SDK as a tracking domain, and many SDKs either do not
declare domains or appear through mediation, bundled resources, or server-side
configuration. Therefore domain evidence can strengthen a signature, but lack
of domain evidence is not treated as a reason to reject direct, vendor-specific
class evidence.

| Tracker | Domain apps | v3 visible apps | Gaps |
| --- | ---: | ---: | --- |
| Braze (formerly Appboy) | 11 | 7 | `com.amapps.simple`, `com.comuto.comuto`, `com.getir.ios`, `com.picsart.studio` |
| PubMatic | 39 | 39 | none |
| PubNative | 54 | 52 | `AlexisBarreyat.BeReal`, `com.JacobVanHaag.ColorMatch` |
| mParticle | 1 | 1 | none |
| Nielsen | 2 | 2 | none |
| OutBrain | 5 | 1 | `com.investing.app`, `de.motain.iliga`, `iphone.thescore.com`, `uk.co.guardian.iphone2` |
| Singular | 22 | 19 | `com.ubercab.UberClient`, `com.ubercab.UberEats`, `com.ubercab.UberPartner` |
| Tenjin | 1 | 1 | none |
| AppMetrica | 14 | 14 | none |

The gaps are domain-only cases in the currently stored data. They should not be
converted into class signatures without class-name evidence, but their existence
is expected and does not invalidate independently class-validated signatures.

## Important Negative Controls

The following candidates are intentionally hidden because observed matches are
generic, mediation-only, or otherwise too noisy for website display:

- `Tune`: catches iTunes/tuner classes.
- `Radar`: catches chart, Stripe Radar, and UI radar classes.
- `Reveal Mobile`: catches common reveal UI classes.
- `Repro`: catches Instabug reproduction and generic reproduction classes.
- `X-Mode`: catches generic `XModel` classes.
- `Huawei Mobile Services (HMS) Core`: catches generic location SDK descriptors.
- `SmartLook`: only observed as ByteDance/Pangle ad manager bridge classes.
- `SuperAwesome`: mostly SML bridge classes; insufficient automated evidence
  for visible promotion.
- `Verve`: mostly mediation/SafeDK adapter classes; insufficient automated
  evidence for visible promotion.
- `IAB Open Measurement`: measurement infrastructure, not a tracker company by
  itself.

## Known Caveats

- v3 is not yet wired into server/frontend replay. Current work only produces
  and validates the signature data.
- Some promoted ad-network signatures intentionally include explicit mediation
  adapter classes. These are marked medium or low-medium risk where adapter-only
  evidence is weaker than direct SDK-core evidence.
- Public website display should use only signatures with
  `exposure === "visible"` and should continue hiding
  `non-tracker`, `instrumentation`, and `hidden` entries.
