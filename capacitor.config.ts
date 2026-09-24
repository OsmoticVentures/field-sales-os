import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.osmoticventures.fieldsalesos',
  appName: 'Field Sales OS',
  webDir: 'www',
  server: {
    url: 'https://osmoticventures.com/nb',
    cleartext: false
  },
  ios: {
    limitsNavigationsToAppBoundDomains: true
  }
};

export default config;
