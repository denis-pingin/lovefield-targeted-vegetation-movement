# Targeted Vegetation Movement: study protocol

## Study objective

Test whether measured movement in two predefined regions of a tree changes with concealed random A/B instructions delivered to one practitioner, Denis Pingin. Both regions are measured throughout each recording to estimate the relative response, its size, and its development after each cue. The number of scored recordings is open-ended; results accumulate as recordings are added.

The [analysis methods](analysis-methods.md) define the calculations. Each scored series retains its complete configuration, measurement profile, and identified software releases.

## Questions, predictions and scope

The main prediction is that the relative balance of measured movement shifts toward the instructed region: toward A under A instructions and toward B under B instructions. A shift toward the targeted region can occur while the other region still moves more overall. Repeated instructions can sustain an existing response. The practitioner uses his chosen practice to act on the region announced by the app.

The analysis also describes:

- the difference in A's movement under A and B instructions, and the corresponding difference for B;
- A-to-B versus A-to-A transitions, and B-to-A versus B-to-B transitions;
- response at each elapsed second, including brief, delayed, sustained, or reversing differences;
- movement before arrival and after departure alongside movement during targeting.

The primary comparison estimates whether relative movement shifts toward the randomly assigned region during the response interval. It evaluates the complete targeting procedure performed by this practitioner under the recorded conditions, including his physical response to the cue. Its scope is a target-related movement response; identifying a mechanism would require further experiments.

There is one practitioner. Each target instruction is a randomized observation within his recorded sessions. Inference concerns those sessions and conditions; generalization to other practitioners or settings requires additional data.

Pre-roll and post-roll are recorded periods of absence before arrival and after departure. Their comparison with targeting provides descriptive context. Their fixed order leaves changes over time inseparable from changes associated with practitioner presence.

## Preparation and scored collection

Preparation establishes suitable collection settings, regions, and motion profiles. Each analysis revision retains its original inputs and settings. A recording contributes once to a selected analysis version. Results obtained while tuning the method are exploratory.

A scored series uses fresh recordings after its protocol, code release, complete scientific configuration, collection settings, measurement profile, quality rules, and statistical version have been published and frozen. Target count and timing are fixed across its runs; the total number of runs is open-ended. Evidence begins at E=1 using only that series' scored recordings.

The same equations support preparation analyses with different response durations and target counts, saved before each run. Such an accumulation estimates the response across the tested procedures. Each analysis retains its exact area-weighted measurement profile.

## Apparatus, roles and site

Use a Nikon Z8, a stable camera tripod, an Android instruction phone, and a Mac for setup and analysis. The practitioner can conduct the procedure independently, with optional help for practical setup. The phone and server record authenticated assignments and timing. The Mac retains camera originals and performs the analysis. Exported analyses accompany published results.

Choose an accessible tree and two non-overlapping regions visible in one fixed camera view. Keep the practitioner, other people, and equipment outside those regions. Include a stationary reference surface for detecting camera shake. Frame the scene so that the expected leaf or branch motion can be tracked. Use regions that adequately represent the visible foliage. Area-weighted motion accommodates unequal polygon areas as specified in the analysis methods.

Record weather and site context for each run. The practitioner may visit, set up, and test at the site beforehand and choose a suitable starting time. Once randomized instructions begin, follow the saved sequence and retain the run's outcomes, including interruptions.

Save GPS positions for practice, waiting, and post-roll absence during setup, with capture time and reported accuracy. A position can be reused when unchanged. Derived distances describe approximate horizontal separation between recorded positions.

## Saved settings

Settings are fixed before the first assignment in a run and retained with its permanent ID and optional tag. Preparation can change these settings between runs.

| Setting | Definition |
| --- | --- |
| Absent pre-roll | Positive recorded absence after Start and before Approach. |
| Response per target | Positive duration measured from actual cue playback onset. |
| Target count | Positive integer specifying the number planned before Start. |
| Between-target recovery | Nonnegative duration between successive targets. |
| Release announcement | With positive recovery, either Release or Response complete; no separate announcement when recovery is zero. |
| Absent post-roll | Positive duration beginning at Away. |

The series configuration supplies the exact numerical values, including accepted defaults. Scored recordings use that fixed configuration and the qualified, frozen analysis profile. Response durations are fixed settings. Each target label is drawn independently, permitting both switches and repetitions.

## Camera and regions

Use H.265 8-bit MOV, 3840 x 2160, 25p. Enable recorded timecode, Free run, and Current time after checking the camera's date and time. Keep framing, zoom, exposure, focus, and stabilization settings fixed within the recording and retain their values. Camera timecode provides a check on the original; filmed clock references establish the mapping from video to event time. Preparation originals in other supported formats retain their recorded format.

Before scored targeting, record a short setup clip from the final camera position. Export a full-resolution frame on the Mac and define polygons for A, B, and one stationary background region. Save this setup before the first target.

Retain the source video's identity and hash, selected frame number and presentation time, PNG identity, hash and dimensions, polygon coordinates, and profile. The run retains the setup identifiers, image dimensions, and coordinates; the Mac retains the matching image and its source-frame record. Frame numbering starts at zero. The selected setup image and regions must remain identifiable when the run is imported for analysis.

Preparation permits retrospective region selection from a frame of the main recording. Record that choice and its revisions, distinguishing the main recording from a separate setup clip. Scored setup is prospective. A changed camera view requires a new setup before scored targeting resumes. Region selection is completed without using the targeting result to favor particular regions. Analysis requires the saved setup and its matching image.

## Field sequence

1. Save the run, settings, optional tag, site positions, and setup. Designate the instruction phone and test audible playback. Keep the page in the foreground with its screen awake. Automatic reconnection resumes the recorded state while preserving delivery of each target only once.
2. Start the camera. On the instruction phone, measure, display, and save an opening clock reference while it is visible to the camera. The display includes the run ID, separate date and time, and measured clock uncertainty.
3. Walk to the waiting position with the phone. Press Start while away. For a scored run, wait for public start registration to confirm; the configured pre-roll begins after confirmation. Preparation runs begin pre-roll directly. Pre-roll excludes registration time, camera setup, and the walk away.
4. On Approach, walk to the practice position and tap Arrived. The first concealed target is requested and announced after arrival.
5. Target the announced region for its configured response period. The phone displays and speaks the same target at playback onset. Continue through automatically delivered instructions until the planned count is reached. With zero recovery, the next request follows the previous response end. Retain any service or playback gap at its actual duration.
6. With positive recovery, follow Release or Response complete, as configured. The next target follows the recovery interval and completed announcement. The final target ends with Depart.
7. Leave the practice position. Tap Away after reaching the away position. Post-roll begins then. Wait for Run finished.
8. Return to the camera, measure, display, and save the closing clock reference, then stop recording. The return and closing-clock display occur outside post-roll.
9. Export the completed or interrupted run record, retain the camera original, and import them on the Mac. Confirm the saved setup, record the opening and closing clock frames, review obstruction, and analyze. Inspect the motion checks and report.

An interrupted run retains its state and every generated assignment. A generated assignment without successful delivery or sufficient footage remains an unknown outcome. Unused tickets with no generated assignment contribute no observation.

## Public start record

Before a scored run's timed sequence begins, its start is registered on Base through a non-revocable Ethereum Attestation Service record. The record identifies the study, series, run, fixed-configuration hash, and software version. Its transaction, attestation identifier, block number, and block time make the registration independently inspectable. The public registry specifies its network, signer, schema, and first inventory block.

The camera records before Start. The timed sequence begins after a successful transaction receipt in a sealed Base block. If confirmation is uncertain, keep recording and retry the retained Start action; the application recovers the same transaction and run. A pending registration remains unresolved until its actual outcome is established. If the sequence is stopped while registration is pending, later confirmation preserves the start record while the run remains stopped.

The public Study data page lists registered runs independently of result publication, with separate execution, recording-availability, and analysis states. Its block and synchronization information identifies how current the inventory is. Preserve the start record when a sequence, recording, analysis, or upload fails, and publish a dated explanation with the available records. A livestream is optional. Preparation runs use the preparation workflow without public start registration.

Registration establishes that a scored start was recorded. Recording availability and generated assignments are accounted for separately; unavailable outcomes follow the statistical rules below.

## Concealed assignment and audit

When each target is due, the server requests a fresh independent fair A/B assignment from the RANDOM.ORG Signed API. It uses one reserved ticket per assignment with n=1, min=0, max=1, replacement=true, and fresh generation; provider value 0 maps to A and 1 to B. Ticket identifiers are reserved before use. Target values are generated only when due, immediately before delivery of the instruction. With showResult=false, public ticket lookup conceals the generated value. The phone displays and announces the returned target at playback onset.

Save the ordered ticket manifest, generation rules, and run configuration before use. Retain the provider request, signed result, ticket ID, revealed label, actual playback time, unused tickets, and errors. The saved ticket rules determine the label in an imported run. The analysis recodes that label as Z=1 for A and Z=0 for B, a separate statistical convention.

Retries for one target opportunity retain the same generated instruction. A service failure stops delivery and is recorded. Repeated targets, long streaks, and single-label runs remain in the record. Independent fair assignments impose no balance or minimum-switch requirement. A run with few switches contributes to the main randomized comparison while supplying limited information about switching.

After the practitioner selects the start time, targets follow the saved flow regardless of apparent movement or weather. Preparation settings for a later run can use earlier results. All future assignments remain concealed. Practical interruptions retain every assignment already generated.

## Timing and recorded boundaries

Retain button, server, provider, cue-availability, audio-playing, and audio-end events separately. Cue time is the recorded-audio playing event on the designated phone, mapped to server UTC. This event defines the response window.

The phone compares its clock with the server before designation, before starting, and after reconnection. Each comparison uses five exchanges. For phone send and receive times c1 and c4, and server receive and send times s2 and s3, the offset is ((s2-c1)+(s3-c4))/2 and uncertainty is ((c4-c1)-(s3-s2))/2. Retain all exchanges and use the valid exchange with the lowest round-trip time. Detect wall-clock jumps and keep distinct mapping segments. Each cue identifies a measured exchange from the same phone and segment.

Opening and closing filmed clock references map video presentation times to server UTC by linear interpolation. At each end, identify a sharp readable frame and retain its frame number, presentation time, displayed server time, clock-reference ID, and image preview.

The clock display advances on browser redraws. Timing precision is determined by the measured alignment allowance: one actual frame interval for frame selection, normally 40 ms at 25p, plus the relevant measured clock uncertainties and cue mapping allowance. Scored windows require a combined allowance of at most 0.5 seconds. A preparation recording with audible cues checks for gross disagreement between calculated cue positions and recorded playback. A failed timing check makes the affected motion outcomes unavailable.

## Motion measurement and qualification

Detect Shi-Tomasi image features and track them between successive original frames using pyramidal Lucas-Kanade optical flow. Motion is measured as displacement in the two-dimensional camera image, expressed in pixels per second using the actual frame presentation times. Its interpretation depends on camera geometry, visible texture, and tracking coverage. Retain frame-pair speeds, technical diagnostics, and the exact profile settings.

Use **area-weighted motion** for both preparation and scored analysis. Divide each selected region into a fixed image grid, calculate mean tracked speed within each cell, and average the measured cells using their area inside the region as weights. This gives equal image areas equal weight even when they contain different numbers of tracked points. The [analysis methods](analysis-methods.md#2-motion-measurement) specify sampling, aggregation, and coverage.

A cell with too few reliable matches is unmeasured. Retain the measured fraction of each region; insufficient coverage makes its motion outcome unavailable. Preparation establishes suitable settings through measurement qualification. Freeze the complete qualified profile before scored collection.

Qualification uses preparation footage and controlled image tests:

- stationary images and known translations check units and displacement extraction;
- localized moving patches test sensitivity when most of a region is still;
- duplicated image content, unequal region areas, and varying sample density check the area weighting;
- brightness-only variation tests spurious tracking;
- annotated weak, strong, and localized foliage motion supports inspection of accepted tracks, counts, and regional curves;
- stationary-background shake and saved obstruction reviews identify unusable spans.

Conduct measurement qualification without displaying assignment-linked results, and record any prior knowledge of assignments. Controlled translations use shifts of 0, 0.25, 1, and 3 pixels per frame pair, including horizontal, vertical, and diagonal motion. For textured images, require mean speed error <=max(0.1 pixel/frame, 10% of supplied speed). For stationary and uniform brightness-only images, require <=0.05 pixel/frame residual. For a localized moving patch, compare known displacement at the accepted feature positions using the same tolerance, then verify the regional summary using the specified cell-area weights. These tolerances assess controlled images; representative footage also requires inspection for track loss, wrong matches, and missed moving portions. Retain annotations and outcomes, including failures. Resolve qualification failures and version the revised profile before scored use.

## Analysis and decision

Use one-second bins anchored to actual cue onset, retaining the final partial bin at its actual duration. Each instruction is one randomized observation. Frames, tracks, and elapsed-second bins are measurements within that observation.

A's share of the two regional movement indices supplies the relative outcome. Comparing this share under A and B targeting gives an effect in relative-share percentage points. For example, a share of 45% under B and 50% under A corresponds to a 5-point shift. The separate A and B motion curves show whether that shift involves increased motion in one region, decreased motion in the other, or both.

The prespecified evidence calculation combines a full-response comparison and elapsed-second comparisons with fixed weights. The primary evidence threshold is E=20. Under the stated no-current-target-effect hypothesis, the probability of crossing this threshold at any accepted run update is at most 5%. The [analysis methods](analysis-methods.md#4-one-primary-accumulating-evidence-process) define the hypothesis, weights, calculations, and assumptions.

Report effect estimates and simultaneous confidence ranges alongside evidence. Evidence measures agreement with the randomized target pattern; the estimate and range describe its magnitude and precision. Confidence ranges can exclude specified sizes of the measured effect under the tested conditions. Full-response and elapsed-second ranges address their respective windows. The study imposes no minimum worthwhile effect size or requirement for a visibly noticeable change.

Raw A/B differences, switch curves, and pre/post-roll comparisons are descriptive results with their contributing counts. Raw pixel speeds are interpreted within their camera view. The primary randomized decision uses the single prespecified evidence threshold.

## Failed outcomes, order and corrections

Retain all started runs, including interruptions and invalid footage. Process generated assignments in collection order. An accumulation covers a resolved chronological prefix: all earlier runs have an analysis or an explicit disposition for unavailable outcomes. Later results wait until earlier statuses are resolved. A registered start with no generated target remains publicly listed and contributes no target observation.

Record interruptions, partial or unavailable camera files, and analysis or publication failures with their times and reasons. Corrections are dated additions that preserve the earlier statement. Completion and issue reports are Lab records linked to the start registration.

Every generated assignment remains in the analysis record. Unavailable outcomes contribute the specified uncertainty bounds. A missing bin receives an unknown relative-outcome range; the evidence calculation uses its conservative bound and the effect range widens accordingly. A partially missing full response retains the known portions and bounds the remainder. An unauthenticated assignment leaves the series unqualified until the randomization record is resolved.

Each recording contributes once per analysis revision. Preserve original analyses when correcting inputs, then recompute the affected chronological prefix under an identified revision and explain the correction. Scored evidence continues across the series. A scored-method change requires a protocol and version amendment before further collection.

## Reporting, preservation and publication

Every result identifies preparation or scored status, run ID and tag, human-readable local dates, original hashes, setup, software and configuration versions, profile, event records, timing references, quality decisions, and analysis revision. Retain raw frame-pair measurements, one-second summaries, assignments, and outputs sufficient to reproduce the calculation.

The readable report includes the conclusion supported by the analysis, counts, effect estimate and range, regional traces, target transitions, evidence history, and descriptive absence comparisons. Machine-readable results are available alongside it.

Public results cover the scored series. Each publication identifies its recordings and analysis revisions, pending and failed statuses, cumulative history, current evidence, and any earlier threshold crossing. Preparation analyses are retained separately.

Publish original recordings, setup and region records, timing and assignment inputs, results, and the software and configuration needed to reproduce each calculation. Identify exact input hashes and versions. The website article, downloadable protocol and methods, and public repository contain the same scientific content for the selected version. Earlier results retain their associated documents when current documents are revised.

Before scored collection, document applicable research oversight, participant consent, consent to publish identifiable recordings, required site permissions, funding, conflicts of interest, and authorship. Timestamp the prospective protocol and registration before fresh scored data and report deviations.

## Sources

- [Nikon Z8 video file types](https://onlinemanual.nikonimglib.com/z8/en/video_file_types_40.html) and [timecode settings](https://onlinemanual.nikonimglib.com/z8/en/vrm_timecode_194.html): camera configuration.
- [OpenCV optical flow](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html): feature tracking. The [published tree-motion study](https://doi.org/10.1016/j.agrformet.2013.10.003) provides methodological precedent; the analysis methods identify the specific spatial-grid adaptation used here.
- [RANDOM.ORG Signed API](https://api.random.org/json-rpc/4/signed): signed assignment generation.
- [Analysis methods: scientific foundations](analysis-methods.md#scientific-foundations): mathematical sources and their use.
