import {STUDY_NAME, publicStudyUrl} from './study-paths.mjs';

export const publicStudyIdentity = Object.freeze({
  slug: 'tree-targeting',
  name: STUDY_NAME,
  subtitle: 'A randomized study testing whether vegetation movement changes according to the region the practitioner is instructed to influence.',
});
export const studyPages = [
  ['about', 'Overview'], ['methods', 'Methods'], ['results', 'Results'],
  ['recordings', 'Study data'], ['reproducibility', 'Reproducibility'],
];
export const availableStudies = [{...publicStudyIdentity, pages: studyPages, url: publicStudyUrl}];

export const publicStudyContent = {
  about: {
    title: 'Overview',
    introduction: publicStudyIdentity.subtitle,
    objective: "This single-practitioner study investigates Denis's reported ability to influence localized tree movement during energy practice. The primary hypothesis is that the relative balance of measured movement shifts toward the randomly assigned target. Both regions are observed simultaneously; the targeted region need not become the more mobile of the two.",
    procedure: "Two non-overlapping regions, A and B, are defined in a fixed camera view before data collection. When each new instruction is due, the study server requests a fresh random assignment from RANDOM.ORG, an independent random-number service, with equal probability of A or B. Future targets have not yet been generated and cannot be inspected in advance. The phone then displays and speaks the assigned region, and Denis directs his practice toward it. Video analysis measures movement in both regions over the same observation interval, beginning at recorded cue playback. RANDOM.ORG's digitally signed result and generation time are retained alongside the playback time so the assignment and its timing can be checked independently.",
    interpretation: 'The primary analysis estimates how the balance of movement differs between A and B assignments. Effect size describes the magnitude and direction of that difference. Statistical evidence and uncertainty are reported separately. Inference concerns the targeting procedure under the recorded conditions; identifying a physical mechanism requires additional experiments.',
    accumulation: 'Recordings contribute to a sequential analysis: evidence and uncertainty are updated as additional recordings are included, using rules specified before data collection. New observations can strengthen or weaken the evidence. Each published update retains its contributing recordings and complete analysis.',
    inspection: 'The protocol, recording materials, analysis settings and software versions document the path from recorded movement to the reported result. Original videos and complete analysis outputs are available with each recording.',
  },
  results: {
    title: 'Results',
    introduction: 'The analysis estimates whether relative movement shifts toward the randomly assigned tree region. Effect size describes the magnitude and direction of the estimated response; the confidence limits describe its uncertainty, and the evidence measure assesses its compatibility with the no-target-effect hypothesis.',
    description: "Results are updated as recordings are added. The charts show the accumulated findings, and the table separates each recording's contribution from the cumulative result. Recordings awaiting analysis remain listed with their current status.",
  },
  recordings: {
    title: 'Study data',
    introduction: 'Study data connects each recording to its original materials, saved settings, target assignments and individual analysis. Open a recording to inspect its measurements, figures and complete source files.',
    description: 'Video playback may use a converted viewing copy. The original recording used for analysis is available as a separate download. Each result version retains the files and analysis that support it.',
  },
  recording: {
    title: 'Recording details',
    introduction: 'This recording brings together its original materials, saved settings, target assignments and individual analysis.',
  },
  protocol: {title: 'Study protocol'},
  analysis: {title: 'Analysis methods'},
  methods: {
    title: 'Methods',
    introduction: 'The retained protocol and analysis methods define the hypothesis, randomized procedure, measurements and interpretation rules used for this study.',
    protocol: 'The study protocol establishes the hypothesis, randomized procedure and recording rules. It specifies how targets are assigned, when movement is observed and how recordings enter the study.',
    analysis: 'The analysis methods specify measurement, qualification, scoring and interpretation. They define how the recorded movement becomes individual and accumulated results, with uncertainty and evidence reported separately.',
    reproduction: 'Reproducibility provides the exact software, settings and input files used for each result, with executable instructions for checking the calculation.',
  },
  reproducibility: {
    title: 'Reproducibility',
    introduction: 'The retained settings, software versions and original inputs identify how each result was produced. These materials support independent inspection and computational reproduction.',
    description: 'The study record includes the collection software, motion-analysis settings and statistical analysis used for each result. Reproduction uses the retained original inputs and the identified software version.',
    reproduction: 'Download the file manifest and its listed inputs, obtain the identified source package, and run the reproduction command below. The manifest lists the files used for this result version. File hashes are fingerprints that verify the downloaded bytes; rerunning the calculation checks whether those inputs reproduce the reported result.',
  },
  empty: 'No scored results have been published yet.',
  emptyDescription: 'Results will appear here when the first set of recordings and analyses is published.',
  currentMaterials: 'The procedure and software are developing. The protocol, software versions and scientific settings used for scored collection will be identified when that series starts.',
  currentMethodsIntroduction: 'The current protocol and analysis methods describe the hypothesis, randomized procedure, measurements and interpretation rules for this study.',
  currentSoftwareIntroduction: 'Inspect the current collection and analysis software, its canonical scientific documents and its identifiable source version.',
  emptyRecordings: 'No scored recordings have been published yet.',
};
