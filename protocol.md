# Targeted Vegetation Movement: study protocol

## Study objective

Test whether measured movement in two predefined tree regions follows concealed
random A/B instructions delivered to one practitioner, Denis Pingin. Measure both
regions throughout;
estimate the relative response, its size, and how it develops after each cue.
The number of scored recordings is open-ended. The method permits examining
accumulating results and choosing whether to collect more.

The [analysis methods](analysis-methods.md) define the calculations. The complete
configuration, measurement profile and identified software releases accompany
each scored series. The outcome is vegetation movement measured from video.

## Questions, predictions and scope

The main prediction is that the relative balance of measured movement shifts
toward the instructed region: toward A under A instructions, toward B under B
instructions. A shift toward the targeted region can occur even when the other region
still moves more overall.
Repeated instructions can sustain an existing response; they need not produce
another increase. No particular hand movement or internal technique is tested.
The practitioner uses his chosen practice to act on the target announced by the app.

The analysis also shows:

- how A's movement differs when A rather than B is targeted, and conversely for B;
- A-to-B versus A-to-A transitions, and B-to-A versus B-to-B transitions;
- response at each elapsed second, including brief, delayed, sustained or
  reversing differences;
- movement during absent pre-roll and post-roll versus during targeting.

The randomized comparison concerns the whole targeting procedure, including
the practitioner's response to the cue. A supported result does not identify an
energy,
airflow or other mechanism, nor establish an effect of attention without
physical movement. The camera outcome requires no wind sensor or CSV. Ordered
pre/post-roll comparisons describe this recording's absent/present conditions;
they do not independently establish that presence caused a change.

There is one practitioner. Repeated targets are repeated randomized instructions,
not independent people or trees. Inference concerns the sampled sessions and
conditions. Generalization to other practitioners or settings requires new data.

## Preparation and scored collection

Preparation allows changing settings between runs, inspecting results, revising
regions, and developing the motion profile. Every revision retains the original
inputs and settings. A recording contributes once to a selected analysis version;
reanalysis is a revision, never another observation. Retrospective preparation
results remain exploratory, including a threshold crossing after method tuning.

A scored series begins with fresh recordings after publishing and freezing its
protocol, code release, complete scientific configuration, collection settings,
profile, quality rules and analysis version. Its target count and timing choices
are identical across runs; its total number of runs is not fixed. The separate
preparation history does not supply starting evidence. Start at E=1.

The same analysis equations support both modes. Preparation may use different
response durations and counts, recorded before each new run. A mixed preparation
summary concerns those tested procedures collectively. It does not establish
that the eventual locked procedure works equally well everywhere.

## Apparatus, roles and site

Use a Nikon Z8, stable camera tripod, an Android instruction phone,
and a Mac for setup and analysis. The study can be conducted solo. A helper is
optional for practical setup, not a condition of the design. The phone/server
records authenticated assignments and timing. The Mac retains the camera
originals and performs analysis. Published results include the exported analyses and remain available
independently of the analysis computer.

Choose an accessible tree and two non-overlapping regions visible in one fixed
camera view. Keep the practitioner, other people, and equipment outside those
regions. Include a
stationary reference surface in the view for shake detection. Choose framing
that makes the anticipated leaf or branch motion trackable; approximately
similar region sizes are helpful, but exact equality is not required. Record
weather/site context briefly without retrospectively selecting only favorable
results. Conditions can justify postponing before the first randomized cue.

The practitioner may visit, set up, and test at the site before a recording.
Pre-roll measures absence after setup; it does not require a previously unvisited
environment. Save the practice, waiting and post-roll-away GPS positions by tapping
at those positions during setup, with capture time and reported accuracy. Reuse
a saved position when unchanged. Derived distances are approximate horizontal
distances, not measured boundaries of an influence. No sensor-placement or route
survey is required.

## Saved settings

Settings are fixed before the first assignment in a run. A later preparation
run may change them. The settings themselves, including defaults accepted
unchanged, are retained with the run ID and optional tag.

| Setting | Definition |
| --- | --- |
| Absent pre-roll | Positive recorded absence after Start and before Approach. |
| Response per target | Positive duration measured from actual cue playback onset. |
| Target count | Positive integer specifying the number planned before Start. |
| Between-target recovery | Nonnegative duration between successive targets. |
| Release announcement | With positive recovery, either Release or Response complete; no separate announcement when recovery is zero. |
| Absent post-roll | Positive duration beginning at Away. |

The exact numerical values are specified in the configuration retained with the
series. Scored recordings use the same fixed configuration. Preparation may vary
these values between runs to establish a suitable procedure. Response durations
are not randomized and the assignment sequence does not force alternation.
Tracking settings and acceptance rules are retained in a versioned analysis
profile. Scored collection uses the qualified, frozen profile. There is no
additional pre-cue baseline waiting period.

## Camera and regions

Use H.265 8-bit MOV, 3840 x 2160, 25p. Enable recorded timecode, Free run and
Current time after checking camera date/time. Keep framing, zoom, exposure,
focus and stabilization settings fixed within the recording and retain their
values. Available timecode helps check the original; the filmed clock supplies
the camera-to-event-time mapping. Do not change format merely because a
preparation original has another supported format.

For scored setup, record a short clip from the final framing, transfer it to the
Mac, select a readable frame using a frame-number input or Previous/Next, and
export the full-size PNG. Name it from its source video, for example
`tree-setup-DSC_0056.png`, without overwriting an earlier export. Define A, B and
one stationary background polygon in that image. Save before targeting.

Retain source-video identity/hash, selected frame number and presentation time,
PNG identity/hash/dimensions, polygons and profile on the Mac. The run carries
the setup identifiers, dimensions and polygon coordinates. Resolve its exact
PNG from the Mac's retained setup records when importing it. The imported run shows its saved image, regions and source frame.
Frame numbering starts at 0 in both setup and clock-reference selection; the
last frame number is the decoded frame count minus one.

Preparation also permits defining regions after recording from a frame of the
main video. Label that choice retrospective, retain revisions, and distinguish
main-video from setup-video provenance. It does not qualify as prospective
scored setup. Missing setup is visible and must be completed before analysis;
do not infer or substitute regions that were not recorded.

A changed camera view requires new setup before a scored target. Do not select
new scored regions because another region gave a better targeting result.

## Field sequence

1. Save the run, settings, tag if useful, site positions and setup. Designate the
   instruction phone and test audible playback. Keep the page in the foreground
   with its screen awake. Automatic reconnection resumes the authoritative state;
   it must not repeat an already delivered target.
2. Start the camera. On the instruction phone measure, display and save an
   opening clock reference while it is visible to the camera. The display
   includes the run ID, separate date/time and measured clock uncertainty.
3. Walk to the waiting position with the phone. Press Start while away. For a
   scored run, wait for the public start registration to confirm. The configured
   pre-roll then begins, excluding registration time, camera setup and the walk
   away. Preparation runs begin pre-roll directly.
4. On Approach, walk to the practice position. Tap Arrived. Only then may the
   first concealed target be requested and announced.
5. Target the announced region for its configured response period. Display and
   speak the same target at playback onset. Continue through automatically
   delivered instructions until the planned count is reached. With zero
   recovery, the next request follows the previous response end; actual service
   and playback gaps are retained, never treated as instantaneous.
6. With positive recovery, follow Release or Response complete, as configured.
   The next target follows the recovery interval and completed announcement.
   The final target instead ends with Depart.
7. Leave the tree position. Tap Away only after reaching the away position.
   Post-roll begins then. Wait for Run finished.
8. Return to the camera, measure/show/save the closing clock reference, then
   stop recording. The return and closing-clock display are outside post-roll.
9. Export the completed or interrupted run record, retain the camera original,
   import them on the Mac, confirm setup, enter opening/closing clock frames,
   review obstruction, and analyze. Inspect the resulting motion checks and
   report. Preparation may lead to another run with revised saved settings.

There is no requirement for an assistant to announce cues, operate a timer, or
measure every cue manually. If a run is interrupted, retain its state and every
assignment already generated. Unused tickets without generated assignments are not observations. A generated
assignment without successful delivery or sufficient footage remains an unknown
outcome; failed speech cannot selectively remove a label.

## Public start record

Before a scored run's timed sequence begins, its start is registered on Base.
The start registration is a non-revocable record in Ethereum Attestation Service.
It identifies this study, the series, the run, the hash of its fixed configuration
and the identified software version. The transaction, attestation identifier,
block number and block time provide independently inspectable evidence of the
registration. That registration remains visible even if the sequence never
begins, the run is interrupted, or its recording or analysis is unavailable.
Test uses Base Sepolia; scored research uses Base. The public registry identifies
the network, signer, schema and first block from which its inventory is read.

The Z8 must be recording before Start. The timed sequence begins after a
successful transaction receipt in a sealed Base block. If confirmation is
uncertain, keep the camera recording and retry the retained Start action. The
application recovers the same transaction and run. An unresolved registration
is not evidence that no start was posted. If the sequence is stopped while
registration is pending, later confirmation preserves the run's start registration without restarting timing
or issuing targets.

The public Study data page lists registered runs independently of result
publication. It distinguishes execution state, recording availability and
published analysis. Its block and synchronization information shows how current
the external inventory is. Preserve the start when a recording, analysis or
upload fails, and publish a dated explanation with the available records.
A livestream link is optional; neither streaming nor an analysis is required
for the start to be registered. Preparation runs do not use this registry.

Registration makes an omitted run discoverable. It does not establish that
a camera recorded successfully, authenticate an observed effect or supply a
missing measurement. The scientific rules below determine how generated
assignments and unavailable outcomes contribute.

## Concealed assignment and audit

When each target is due, request a fresh independent fair A/B assignment from
the RANDOM.ORG Signed API. The server uses one reserved ticket for each
assignment, with n=1, min=0,
max=1, replacement=true, fresh generation, 0 maps to A and 1 maps to B.
The saved ticket rules are authoritative for decoding imported instructions.
The analysis separately recodes the resolved label as Z=1 for A and Z=0 for B;
that statistical indicator is not the provider bit. Ticket
identifiers are reserved before use, but the future assignments are not generated
in advance. With showResult=false, public ticket lookup does not disclose the
generated value. The phone displays and announces the returned target at cue
playback; the signed generation record and actual playback time are retained.
Save the ordered ticket manifest, generation rules and run configuration before
use. Retain provider request/result signatures, ticket IDs, revealed labels,
unused tickets and errors. Do not expose future assignments. Retries for one
opportunity return the same instruction, never a reroll. No random fallback is
silently substituted when the service fails.

Repeated targets, long streaks and single-label runs remain in the record.
Neither balance nor a minimum number of switches is enforced. Those restrictions
would change the assignment distribution and require a different method. A run
with few switches may be uninformative about switching while still contributing
to the main randomized comparison.

No assignments are chosen because the wind or movement appears ready for one
particular label. The practitioner may choose a suitable starting time; thereafter
targets
follow the fixed run flow. A new run's preparation settings may use earlier
results, but not its concealed assignments. Stop for a practical problem without
discarding what has already been assigned.

## Timing and recorded boundaries

Retain button, server, provider, cue-availability, audio-playing and audio-end
events separately. Cue time is the recorded-audio `playing` event mapped from
the designated phone to server UTC. It is not provider response or server receipt
time. Keep actual playback and any failure visible.

The phone automatically compares its clock with the server before designation,
before starting and after reconnection. One comparison uses five exchanges.
For phone send/receive c1/c4 and server receive/send s2/s3, offset is
`((s2-c1)+(s3-c4))/2`; uncertainty is
`((c4-c1)-(s3-s2))/2`. Retain all exchanges and use the valid lowest-round-trip
one. Detect wall-clock jumps and separate mapping segments. A cue must identify
a measured clock exchange for that same phone and segment.

Opening and closing filmed references map video presentation times to server
UTC by linear interpolation. On the Mac select one sharp readable frame at each
end, enter the server time visible in it, and select its retained clock reference.
Save both frame numbers, times, previews and reference IDs. Reopen with these
values prefilled. A not-yet-selected closing frame input initially contains the
last frame number. No automatic OCR or frame slider is required.

The clock display advances on browser redraws; fractions displayed are not
claims of equivalent accuracy. The working frame-selection allowance is one
actual frame interval, normally 40 ms at 25p. Add the relevant measured clock
uncertainties to the frame allowance and cue mapping allowance; require combined
alignment allowance at most 0.5 seconds for scored windows. An existing preparation
recording with audible cues checks for a gross playback/mapping discrepancy. This is
an implementation/apparatus check, not a new per-cue field ritual. Future footage
can use any readable normally advancing clock frame. Old one-second-clock
footage requires a readable frame at the visible second transition.

The camera-based outcome requires no wind-sensor record. A timing failure
makes the affected motion outcome unavailable for formal analysis; it does not
turn the motion into zero.

## Motion measurement and qualification

Retain original frames and presentation times. Detect Shi-Tomasi image features
and track them between successive frames using pyramidal Lucas-Kanade optical
flow. Point counts, tracking-window dimensions and acceptance rules are retained
in the selected profile. Keep frame-pair speeds and technical diagnostics, not
only the final score. The [analysis methods](analysis-methods.md#2-versioned-preparation-motion-measurements)
define two versioned measurement methods that may be compared during preparation.

The point-average method uses the arithmetic mean magnitude of accepted feature
speeds within each region and frame pair. Every accepted moving track contributes,
divided by the number of accepted tracks. Region point count alone therefore does
not increase the score. This is a feature-weighted image-motion index, not the
movement of every leaf or an area-weighted physical velocity. Rejecting poor
tracks remains necessary because the mean is sensitive to bad matches.

The area-based method measures local movement across a fixed grid and weights
measured cells by their polygon area. Retain the grid, sampling and coverage
settings. Unknown cells are not stationary foliage. Report the actual measured
area and retain unavailable outcomes when coverage fails. This estimates image
movement across the selected visible canopy, subject to the stated foliage
coverage and perspective limitations.

For a preparation comparison, analyze identical originals, regions, clock
mapping, footage review and cue intervals with each candidate method. Retain both
exact revisions and compare the same recordings in the same chronological order.
The two analyses are alternative measurements of the same observations and do
not provide twice the experimental data. Compare motion fidelity as well as the
effect on individual and accumulated results. Select the scored measurement
method through measurement qualification, not by choosing the most favorable
evidence value. Freeze that method and its complete profile before scored
collection.

Before scored collection, qualify this profile using the existing preparation
material and developer fixtures:

- known stationary and translated images verify units and numerical extraction;
- a localized moving patch verifies a response when most of the region stays still;
- brightness-only variation tests spurious tracking;
- annotated weak, strong and localized real foliage motion lets the investigator inspect
  whether accepted tracks follow what is visible, with counts and regional curves;
- fixed-background shake and the saved obstruction review identify unusable spans.

Do these checks without viewing which target produced a favorable score. They
verify measurement, not the claimed field effect. If the profile fails the localized/quiet checks,
resolve it in preparation and version the replacement before scored use.
Reference arithmetic tests alone do not establish optical tracking accuracy.
Developer fixtures use shifts of 0, 0.25, 1 and 3 pixels per frame pair, including
horizontal, vertical and diagonal motion. For textured fixtures require mean
speed error <=max(0.1 pixel/frame, 10% of supplied speed). For stationary and
uniform brightness-only fixtures require <=0.05 pixel/frame residual. For a
localized patch compare to known displacement at the accepted feature positions,
not a claimed area fraction; apply the same tolerance. These are software-test
tolerances, not certified bounds on real foliage measurement. Inspect real clips
for track loss, wrong matches and missed moving portions before freezing the
profile. Save the annotations and outcomes, including failures.

## Analysis and decision

Use one-second bins anchored to actual cue onsets and the run's actual duration,
with the final partial bin retained. Each instruction is one randomized unit.
Do not multiply evidence as though its frames, tracks or seconds were independent
random assignments. Do not stretch short responses or invent their absent tails.

The relative index expresses A's share of the two measured regional movement
indices. Comparing that share under A versus B gives a dimensionless effect in
percentage points. For example 45% under B and 50% under A is a 5-point relative
shift, not a 5% increase in leaf speed. Keep each region's actual movement and
within-run targeted-versus-other-target differences alongside it. A relative
shift can arise through acceleration in one region or slowing in the other.

The prespecified evidence combines a whole-response comparison with the
elapsed-second comparisons. It retains sensitivity to short responses while
supporting variable preparation durations. There is one primary E threshold,
20, for a 5% anytime false-positive allowance under the stated no-current-target-
effect hypothesis. It is not an effect-size threshold or probability that a
mechanism is true. Exact equations, fixed weights, uncertainty and missing-data
rules are in the analysis specification.

Report cumulative estimates and simultaneous confidence ranges. Small positive
E does not prove an effect; small or declining E does not prove randomness.
A confidence range can rule out specified sizes of the measured outcome under
these conditions. It cannot rule out every possible effect. A whole-period range
does not rule out a brief response that cancels later. No minimum worthwhile
effect or mandatory visually noticeable change is imposed.

Raw A/B differences and switch curves remain visible with counts. They do not
create additional unadjusted success routes. Pre/post-roll is separate descriptive
context. Do not pool raw pixel speeds across different camera geometries as
physical measurements.

## Failed outcomes, order and corrections

Retain all started runs, including interruptions and invalid footage. Process
generated assignments in collection order. Pending earlier data prevents a later
result from being presented as a complete prefix until its status is resolved.
A registered run with no generated target remains publicly accounted for;
it contributes no invented target or measured outcome. Report interruptions,
partial or unavailable camera files, and analysis or publication failures with
their times and reasons. Correct a report with a dated addition that preserves
the earlier statement. Completion and issue reports are Lab records linked to
the start; they are not additional blockchain transactions.

A technically missing bin receives an unknown relative-outcome range, not zero
and not deletion. The method uses its worst case for evidence and widens the
effect range. A partially missing full response retains its known portions and
bounds the remainder. This can reduce evidence substantially, but allows a series
to continue without outcome-selected complete-case analysis or a new data-loss
exception procedure. If the assignment itself cannot be authenticated, mark the
series unqualified until the randomization record is resolved; do not assume a
fair random label for an unauthenticated event.

Never score a recording twice, hide a disagreeing run, or restart scored evidence
after an unfavorable result. Preserve original analyses when correcting inputs.
Recompute the affected chronological prefix under one identified revision and
show the reason and change. Preparation corrections remain exploratory. Scored
method changes need an explicit protocol/version amendment before new collection.

## Reporting, preservation and publication

Every result identifies mode, run ID/tag, local human-readable dates, original
hashes, setup, software/configuration/profile versions, event records, timing
references, quality decisions and analysis revision. Preserve raw frame-pair
measurements, one-second summaries, assignments and outputs sufficient to
recompute the result. Show a plain-language conclusion, counts, effect range,
regional traces, target transitions, evidence history and descriptive absent
comparisons. JSON is retained as downloadable detail, not the only report.

Public results cover the scored series. Each published result identifies its
included recordings and analysis revisions, pending and failed recording
statuses, cumulative history, current evidence and any earlier threshold
crossing. Preparation results do not contribute to scored evidence. The
chronological inclusion and missing-outcome rules above continue to apply.

Publish original camera recordings, setup and region records, timing and
assignment inputs, complete results and the materials needed to reproduce each
calculation. Identify exact input hashes and software versions. Retain the
protocol, analysis methods and complete nonsecret configuration used for the
series. The website renders that same retained protocol as a readable article;
the downloadable source and public code repository contain the same scientific
content. A later document revision does not replace the protocol associated
with an earlier result.

Before scored collection, document the applicable institutional or journal
human-participant determination, participant consent, consent to publish
identifiable recordings, site permission where required, funding, conflicts of
interest, and authorship. This protocol itself supplies no ethics approval,
exemption, or journal acceptance. Timestamp the prospective protocol and
registration before fresh scored data and report deviations. PLOS One submission
guidance is referenced below for reporting requirements; this environmental
measurement is not described as a clinical trial.

## Sources

- [Nikon Z8 video file types](https://onlinemanual.nikonimglib.com/z8/en/video_file_types_40.html)
  and [timecode settings](https://onlinemanual.nikonimglib.com/z8/en/vrm_timecode_194.html).
- [OpenCV optical flow](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html).
  The [published tree-motion study](https://doi.org/10.1016/j.agrformet.2013.10.003)
  is methodological precedent; this profile is not an exact reproduction of its toolbox.
- [RANDOM.ORG Signed API](https://api.random.org/json-rpc/4/signed).
- [PLOS One submission requirements](https://journals.plos.org/plosone/s/submission-guidelines),
  [publication criteria](https://journals.plos.org/plosone/s/criteria-for-publication),
  and [human-subjects policy](https://journals.plos.org/plosone/s/human-subjects-research).
- Mathematical sources and their exact use are retained in
  [analysis methods](analysis-methods.md#scientific-foundations).
