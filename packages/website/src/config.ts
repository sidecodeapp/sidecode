/**
 * Site-wide constants. Centralized here so URLs / contact / author
 * are edited in one place instead of grepping through components.
 */

export const links = {
  // Set to "" to render the linked buttons as visually disabled
  // (pointer-events:none + dimmed). Restore the URL here to re-enable.
  github: "https://github.com/thinkite/thinkite",
  // iOS app — the /ios route redirects to TestFlight (see public/_redirects).
  // It's a TestFlight beta, NOT the App Store, so button copy should say
  // "TestFlight", not "App Store".
  appStore: "/ios",
  // macOS app — the /mac route (Worker) resolves the latest .dmg from the
  // GitHub Releases API and 302s to it; never hard-code a versioned URL here.
  download: "/mac",
  contactEmail: "contact@thinkite.dev",
} as const;

export const site = {
  url: "https://thinkite.dev",
  name: "thinkite",
  author: "Richard Yang",
  license: "Apache 2.0",
} as const;
