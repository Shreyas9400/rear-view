export const APP_NAME = 'Rear-View Assistant';

// On-device self-tests: only in builds made with VITE_SELFTEST set (removed from production bundles).
//   VITE_SELFTEST=1 or detector : native detector on the sample image
//   VITE_SELFTEST=camera        : camera probe (permission, fps, camera -> detector pipeline)
const selftest = import.meta.env.VITE_SELFTEST;
if (selftest === '1' || selftest === 'detector') {
  void import('./selftest/detectorSelfTest').then((m) => m.run());
} else if (selftest === 'camera' || selftest === 'ablation' || selftest === 'isolate' || selftest === 'stream' || selftest === 'drift' || selftest === 'paced' || selftest === 'slowab' || selftest === 'jpegcmp') {
  void import('./selftest/cameraProbe').then((m) => m.run(selftest));
} else if (typeof document !== 'undefined') {
  const root = document.getElementById('app');
  if (root) void import('./ui/rearScreen').then((m) => m.mountRearScreen(root));
}
