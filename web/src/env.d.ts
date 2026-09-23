/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
declare const __USE_MOCK__: boolean;
declare const __OPENCV_PATH__: string;

interface Navigator {
  /** iOS Safari: true when running from the home screen. */
  standalone?: boolean;
}
