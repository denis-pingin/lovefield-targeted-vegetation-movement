# Targeted Vegetation Movement

Software and methods for a randomized, single-practitioner study of whether
measured vegetation movement changes with the region a practitioner is instructed
to target. Two predefined regions of one camera view are measured simultaneously.
Each instruction assigns region A or B using a fresh, digitally signed result
from RANDOM.ORG. Video analysis measures the response in both regions and
calculates individual and accumulating results.

[Study website](https://lab.sourceof.love/studies/targeted-vegetation-movement/public/)
· [Protocol](protocol.md)
· [Analysis methods](analysis-methods.md)
· [Reproducing results](publication-release-guide.md#reproduce-a-published-result)

The study is in preparation. The supplied measurement profiles are development
settings; scored collection and external start registration are disabled in the
shipped configuration. A scored series requires a prospectively fixed protocol,
configuration, measurement profile, and software version. Preparation recordings
do not become scored observations. This repository contains no scored study
results.

## What the software measures

OpenCV tracks image features between successive video frames. Two measurement
methods are available: the mean speed of accepted features within each region,
and a grid method that weights local measurements by the area they represent.
Their settings and quality checks are saved with each analysis. The reported
speeds are apparent image movement in pixels per second, not wind speed or
physical leaf velocity.

The primary analysis asks whether the relative balance of movement follows the
randomized target. It reports the size of that change, its uncertainty, and how
evidence accumulates across recordings. Regional motion, responses over time,
target switches, and pre/post-recording context remain separately inspectable.
The [analysis methods](analysis-methods.md) define the equations, assumptions,
missing-data treatment, and interpretation. A statistical association with target
instructions would not by itself identify a physical mechanism.

## Software components

| Component | Purpose |
| --- | --- |
| [Local analysis](src/study_app.py) | Retain camera originals, define and inspect regions, map video frames to recorded event times, analyze motion, and display results. |
| [Collection service](server/worker.mjs) | Store run settings and events, obtain signed random assignments, coordinate phone instructions, and serve study publications. |
| [Browser interfaces](web/) | Phone controls, local analysis pages, and public result charts. The public reader displays saved calculations; it does not recalculate the statistics. |
| [Reproduction tools](scripts/reproduce-publication.py) | Verify downloaded inputs and repeat the calculations with the source retained in a result publication. |
| [Tests](tests/) and [statistical reference](validation/) | Behavioral tests, numerical checks, and reproducible simulations. |

Scientific calculations run locally in Python. Camera originals and local
analysis data are not included in this source repository. A published result
provides its own file inventory, original inputs, settings, and retained source.

## Install

The local graphical workflow is designed for macOS. It requires Python 3.13,
Node.js 22.12 or newer, Yarn 4.18.0, and `ffprobe` from FFmpeg on `PATH`.
Python dependencies are pinned in [requirements.txt](requirements.txt);
JavaScript dependencies are pinned in [yarn.lock](yarn.lock).

From this repository's root, create a Python environment beside the checkout:

```sh
python3.13 -m venv ../vegetation-environment
../vegetation-environment/bin/python -m pip install -r requirements.txt
yarn install --immutable
```

## Open the local analysis application

```sh
../vegetation-environment/bin/python src/study_app.py --serve --data-dir ../vegetation-study-data
```

Leave that process running. In a second terminal, from this repository's root,
print the local analysis address:

```sh
../vegetation-environment/bin/python -c 'import json; from pathlib import Path; print(json.loads(Path("../vegetation-study-data/service.json").read_text())["url"] + "/tree-targeting/analysis/")'
```

Open that address in a browser. The port is selected at startup and can change.
The service accepts local connections only. The data directory holds retained
originals and analysis state; keep it when updating the software.

A **run bundle** is a JSON export of one recording session's configuration,
assignments, and event times. It does not contain the camera video. To analyze a
run:

1. Select **Choose run or series bundle**, import the exported JSON, select the
   recording under **Imported runs**, and press **Open run**.
2. Check **Saved regions** and the retained setup image. Import the matching setup
   records if they were produced on another installation.
3. Select **Choose original camera video**. Import retains a hashed copy and reads
   the frame timeline; motion analysis is a separate step.
4. Complete **Two filmed clock references** and **Tree footage review** using the
   procedure in the [protocol](protocol.md#timing-and-recorded-boundaries).
5. Select a saved **Analysis profile** and press **Analyze retained originals**.
   Use **View result** or **Open result in new tab** when processing finishes.

An **analysis revision** identifies one calculation with particular inputs,
settings, and software. Earlier revisions remain available. An accumulating
**series** uses one selected revision per recording; reanalysis does not add a
second observation.

## Check the implementation

```sh
../vegetation-environment/bin/python -m pytest tests validation/test_reference.py -v
yarn test
yarn lint
yarn build
```

The Python suite exercises video measurement, timing, statistical calculations,
imports, saved revisions, and reproduction. The JavaScript suite exercises
collection, access boundaries, publication, and browser behavior. The build
prepares study assets and runs a Cloudflare dry run; it does not deploy.

To generate finite-enumeration checks and synthetic simulation results:

```sh
../vegetation-environment/bin/python validation/validate.py > ../vegetation-validation.json
```

These are software and mathematical checks, not field evidence. The numerical
files in `validation/` and `tests/fixtures/` are test inputs and development
examples. Optical measurement also requires inspection of representative foliage
recordings, as described in the protocol.

## Reproduce or host the study

The [reproduction and operation guide](publication-release-guide.md) explains
published-file verification, recalculation, the hosted components, authentication,
and explicit publication of completed results. Local analysis and verification
of downloaded files do not require access to the study's hosted controls.
Operating a separate collection service requires its own infrastructure and
credentials.

## License

Original software is licensed under
[PolyForm Noncommercial 1.0.0](LICENSE-PolyForm-Noncommercial-1.0.0.md).
Original study documents and published material are licensed under
[CC BY-NC 4.0](LICENSE-CC-BY-NC-4.0.txt).
See [LICENSE.md](LICENSE.md) for scope and attribution. Third-party components
retain their own terms.
