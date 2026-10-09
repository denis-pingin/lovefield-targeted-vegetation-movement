import {PUBLIC_BASE} from './study-paths.mjs';

// Retained DSC_0053 frame 25 and setup regions; this is presentation material.
export const publicStudyIllustration = {
  imageUrl: `${PUBLIC_BASE}study-media/tree-tracking.webp`,
  previewUrl: `${PUBLIC_BASE}study-media/tree-tracking-1600.webp`, previewWidth: 1600,
  imageSize: {width: 3840, height: 2160},
  regions: {
    A: [[1110, 17], [1580, 177], [1749, 573], [1688, 1013], [1449, 1354], [1132, 1624],
      [590, 1585], [328, 1338], [269, 865], [241, 446], [604, 146]],
    B: [[2088, 360], [2300, 106], [2666, 68], [3049, 123], [3457, 197], [3373, 455],
      [3331, 1017], [3218, 1442], [3009, 1755], [2667, 1868], [2424, 1467], [2226, 1274], [2064, 849]],
    background: [[999, 1774], [1164, 1801], [1174, 1920], [1169, 2029], [977, 2035], [947, 1890]],
  },
  alt: 'Real tree footage with magenta movement tracks in Region A on the left, cyan tracks in Region B on the right, and a small yellow stationary reference below Region A.',
  caption: 'Movement tracking in DSC_0053, recorded September 25, 2026. Frame 25, one second into the recording.',
};
