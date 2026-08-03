import type { ConfigContext, ExpoConfig } from "expo/config";

// Dynamic Expo config layered over app.json. Varies the iOS bundle id, Android
// package, app name, and URL scheme per build variant so development, preview,
// and production install side by side and DO NOT share an iOS Keychain — i.e.
// pairing state (expo-secure-store / Keychain survives uninstall and is scoped
// by TeamID + bundle id) stays isolated per build instead of bleeding between a
// local dev build and the TestFlight/App Store build.
//
// The variant is chosen by APP_VARIANT, set per EAS build profile in eas.json.
// It defaults to "development" so a plain local `expo run:ios` / `expo start`
// (no profile, no env) gets the `.dev` id and never collides with TestFlight.
//
// production keeps the canonical `dev.thinkite.ios` (matches the App Store
// Connect record + the AASA appIDs served on thinkite.dev/sidecode.app).
// dev/preview get suffixed ids, so Universal Links won't deep-link into them
// unless those ids are added to the AASA appIDs — QR pairing still works on
// every variant.
interface Variant {
  idSuffix: string;
  nameSuffix: string;
  scheme: string;
}

const VARIANTS: Record<string, Variant> = {
  development: {
    idSuffix: ".dev",
    nameSuffix: " (Dev)",
    scheme: "thinkite-dev",
  },
  preview: {
    idSuffix: ".preview",
    nameSuffix: " (Preview)",
    scheme: "thinkite-preview",
  },
  production: {
    idSuffix: "",
    nameSuffix: "",
    scheme: "thinkite",
  },
};

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant =
    VARIANTS[process.env.APP_VARIANT ?? "development"] ?? VARIANTS.development;
  return {
    ...config,
    name: `${config.name}${variant.nameSuffix}`,
    slug: config.slug ?? "sidecode",
    scheme: variant.scheme,
    ios: {
      ...config.ios,
      bundleIdentifier: `${config.ios?.bundleIdentifier}${variant.idSuffix}`,
    },
    android: {
      ...config.android,
      package: `${config.android?.package}${variant.idSuffix}`,
    },
  };
};
