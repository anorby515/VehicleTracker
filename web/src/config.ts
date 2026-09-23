import raw from '../app.config.json';

/** Front-end configuration (web/app.config.json). All values are safe to publish. */
export interface AppConfig {
  appName: string;
  familyName: string;
  oauthClientId: string;
  apiUrl: string;
  vapidPublicKey: string;
  pushWorkerUrl: string;
  googleDriveAppUrl: string;
  googleDriveAppStoreUrl: string;
  nhtsaRecallsUrl: string;
}

export const config: AppConfig = raw as AppConfig;

export const APP_VERSION = __APP_VERSION__;
export const BUILD_TIME = __BUILD_TIME__;
export const USE_MOCK = __USE_MOCK__ || !config.apiUrl;
