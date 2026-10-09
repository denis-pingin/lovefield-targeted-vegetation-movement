# Reproduction and operation

This guide covers verification of published results and operation of the
Targeted Vegetation Movement software. The [README](README.md) describes
installation and local analysis. The [protocol](protocol.md) defines collection;
the [analysis methods](analysis-methods.md) define the calculations.

## Reproduce a published result

A result publication contains a manifest: a JSON inventory identifying its
recordings, selected analysis revisions, input files, settings, retained source,
and outputs. Each file is identified by its size and SHA-256 hash. A publication
is a saved revision; later corrections do not replace its original files.

From the repository root, using the Python environment created in the README:

```sh
../vegetation-environment/bin/python scripts/reproduce-publication.py \
  --url https://lab.sourceof.love/studies/targeted-vegetation-movement/public/ \
  --download ../vegetation-downloads \
  --output ../vegetation-reproduction
```

Use new, empty download and output directories. The study URL selects the latest
completed result when the download begins and then keeps that publication fixed
throughout reproduction. To check an earlier revision, use its publication-specific
URL from the study website. Before any scored result has been published, there
is no result to reproduce; the protocol, methods, and software can still be read
and tested.

For files already downloaded, use the manifest and file directory directly:

```sh
../vegetation-environment/bin/python scripts/reproduce-publication.py \
  --publication ../vegetation-downloads/manifest.json \
  --files ../vegetation-downloads \
  --output ../vegetation-reproduction
```

Keep downloaded files under their SHA-256 names or their unique filenames from
the manifest. Add `--verify-only` to check the files without repeating video
extraction and calculation. Authentication redirects are reported as errors;
protected downloads must first be obtained through authorized access.

Full reproduction verifies the inputs, extracts the retained source packages,
and executes their Python code to recalculate individual analyses, reports, and
the accumulating result. Install the dependencies recorded for that publication;
the latest repository version may not be the version used for its analysis.

The output directory contains `reproduction.json`, including file checks and
numerical comparisons. A mismatch returns a failure; differences are not hidden
by rounding or a fitted tolerance. A runtime mismatch is reported. For a
recording whose original video is unavailable, reproduction can check retained
calculations and missing-data bounds, but cannot repeat that video's extraction.

Successful reproduction establishes agreement with the supplied inputs and
software. The experimental interpretation still depends on the protocol's
randomization, timing, measurement, and completeness assumptions.

## Source identity

[source-inventory.json](source-inventory.json) lists the distributed files and
their hashes. Its combined content hash identifies the complete file set.
Source and documentation provenance are recorded separately when publication
documentation has been edited independently of the application source. The
inventory excludes itself from its file hashes.

Result publications retain the exact collection, analysis, and report-rendering
sources used for them. Use those retained versions when checking a historical
result. Changes to the current repository do not retroactively change an earlier
result's method or configuration.

## Hosted components

The hosted service coordinates recording sessions, saves events and assignments,
and serves study material. It does not calculate the motion measurements or
statistical results shown in the reader; those are uploaded from local analysis.

| Component | Role |
| --- | --- |
| [Cloudflare Worker](server/worker.mjs) | Collection API, phone coordination, study reader, and publication API. |
| `TREE_SESSIONS` Durable Object | Persistent run, series, and event records. |
| `TREE_PUBLICATIONS` R2 bucket | Publication files addressed by their hashes. |
| [Access checks](server/access.mjs) | Verify signed Cloudflare Access identities for protected operations. |
| [RANDOM.ORG client](server/random-service.mjs) | Obtain and retain signed random assignments. |
| [Start registry](server/start-registry.mjs) | Retain and reconcile prospective scored-start records from Base/EAS. |

The public reader uses
`/studies/targeted-vegetation-movement/public/`.
Operator controls and their API use
`/studies/targeted-vegetation-movement/app/`.
The publication API is beneath the operator path and has a separate publisher
identity. Public reading does not grant access to recording controls or uploads.

[wrangler.jsonc](wrangler.jsonc) declares the Worker, assets, database binding,
and publication bucket. Its supplied names describe the study's Test deployment.
They are not credentials or a ready-made configuration for another account.
A separate installation must provide its own resources, host routing, Cloudflare
Access applications and audiences, operator identity, publisher service identity,
and RANDOM.ORG Signed API key. The private deployment automation used to operate
Lovefield Lab is not needed to run local analysis and is not included here.

[start-registry.config.json](start-registry.config.json) contains nonsecret
network configuration. Both configurations are disabled. Scored registration
requires a configured and funded signer, its Worker secret, and the fixed
attestation schema; preparation does not create start registrations. Configuration
alone does not qualify a measurement procedure for scored collection.

## Publish analyzed results

Publishing is an explicit action by an authorized operator. Completing an
analysis or exporting a local report does not upload it.

1. Open the scored series in the local application. Complete the analyses and
   choose one retained revision per recording. Check unresolved and missing
   recordings before preparing the publication.
2. In **Publish results**, check the destination, series, included revisions,
   and pending statuses. Supply a correction reason when replacing a previously
   selected analysis.
3. Press **Publish results**. The application prepares the saved reports and
   supporting files and checks the hosted run inventory for unresolved records.
   This check accounts for collected recordings; it does not recalculate local
   statistics.
4. Follow upload progress. Files are verified by hash, and an interrupted upload
   can resume without another analysis or duplicate contribution.
5. Open the returned links after completion. The reader changes only after the
   complete publication is committed.

The publication contains the original videos, separately identified viewing
copies where supplied, setup images and polygons, clock mappings, footage review,
assignment/event records, profiles, analyses, and accumulating reports. Missing
recordings retain their disposition and surviving inputs. Their statistical
treatment follows the [missing-measurement rules](analysis-methods.md#6-missing-measurements-without-favorable-deletion).

Uploads require the destination's Cloudflare Access service identity. The
uploader supports an explicitly selected process-environment credential source
using `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`, or the installed
operator's Keychain adapter. See [publication-auth.mjs](scripts/publication-auth.mjs)
and [publication-upload.mjs](scripts/publication-upload.mjs). No credentials are
included in this repository. The uploader's destination origins are fixed to the
Lovefield Test and Production services; operating a separate host requires
reviewing that configuration as well as the Worker configuration.

## Updating scientific versions

Preparation supports revised profiles and repeated analysis of the same footage.
Each revision preserves its inputs and settings. Comparisons between methods use
the same recordings and do not add independent observations.

A scored series fixes its protocol, measurement and analysis settings, collection
configuration, and software before fresh data are collected. Subsequent changes
require an identified amendment and preserved earlier results. Publishing source
code or updating the study website does not itself start or lock a scored series.
