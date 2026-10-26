/** Stamped in by vite.config.ts at build time. */
declare const __SKETCH_BUILD__: {
  /** Shown in the status bar and Settings, like 1.0.12; the last part counts Sketch's commits. */
  version: string;
  /** The commit this build came from (empty outside a git checkout). */
  commit: string;
  subject: string;
  builtAt: string;
  /** The main checkout of the repo the build came from, which in-app updates watch (empty in a release build). */
  repo: string;
  /** Sketch's folder inside that repo, like `apps/sketch` (empty when Sketch is the repo's root). */
  path: string;
  /** The number of commits that changed Sketch's folder (the version's last part). */
  build: number;
  /** `release` for a build made by the release workflow, which updates from releases (F16). */
  channel: 'release' | 'source';
  /** The repo's releases page (release builds). */
  releases: string;
  /** The public key that signs each release's latest.json (release builds). */
  key: string;
};
