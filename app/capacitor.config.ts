import type { CapacitorConfig } from '@capacitor/cli';

// Origin is https://localhost by default on Android (secure context).
// allowMixedContent is intentionally NOT set: decide after probe E2 (docs/IMPLEMENTATION_PLAN.md M5).
const config: CapacitorConfig = {
  appId: 'app.smartrearview.rearcam',
  appName: 'Rear-View Assistant',
  webDir: 'dist',
};

export default config;
