/**
 * Cloudflare Worker for the Thinkite website.
 *
 * Resolves `/mac` to the latest macOS `.dmg` via the GitHub Releases API, so the
 * download link always points at the current release without hard-coding a
 * version. Everything else — static pages, and `/ios` via `public/_redirects` —
 * is served by the static-assets layer, which does NOT invoke this Worker. So
 * only `/mac` is ever billed against the Workers request quota.
 */

const OWNER = "thinkite";
const REPO = "thinkite";
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const MAC_DMG = /-arm64\.dmg$/;

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

interface GitHubRelease {
  assets: Array<{ name: string; browser_download_url: string }>;
}

/** Latest published release's arm64 `.dmg` URL, or null on any failure. */
async function latestMacDmg(): Promise<string | null> {
  const init: RequestInit & {
    cf?: { cacheEverything?: boolean; cacheTtl?: number };
  } = {
    headers: {
      Accept: "application/vnd.github+json",
      // GitHub requires a User-Agent on API requests.
      "User-Agent": "thinkite-website",
    },
    // Edge-cache the API response (5 min) so we stay well under GitHub's
    // 60-req/hr unauthenticated limit even under traffic.
    cf: { cacheEverything: true, cacheTtl: 300 },
  };
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`,
    init,
  );
  if (!res.ok) return null;
  const release = (await res.json()) as GitHubRelease;
  return (
    release.assets.find((a) => MAC_DMG.test(a.name))?.browser_download_url ??
    null
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/mac" || pathname === "/mac/") {
      const dmg = await latestMacDmg().catch(() => null);
      // Fall back to the Releases page if GitHub is down / rate-limited.
      return Response.redirect(dmg ?? RELEASES_PAGE, 302);
    }
    // Static pages, assets, and /ios (via _redirects) are served by the
    // assets layer. In the default (assets-first) routing this path is only
    // reached for non-asset URLs; _redirects still applies through ASSETS.fetch.
    return env.ASSETS.fetch(request);
  },
};
