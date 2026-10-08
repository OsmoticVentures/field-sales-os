import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.osmoticventures.fieldsalesos',
  appName: 'ClientOS',
  webDir: 'www',
  server: {
    url: 'https://osmoticventures.com/nb',
    cleartext: false,
    // Shown from the app bundle when the live app cannot load at all (the
    // first launch in a dead zone, before the service worker has kept
    // anything). Every later launch opens from the service worker. OFFLINE.md.
    errorPath: 'offline.html'
  },
  ios: {
    limitsNavigationsToAppBoundDomains: true
  }
};

export default config;
