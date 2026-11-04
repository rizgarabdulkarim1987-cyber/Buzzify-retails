import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Local checks of the product addresses (PACK_HOSTS=supermarket.localhost=SUPERMARKET,...): the
  // dev server only. Browsers resolve *.localhost to this machine, so no hosts file is needed.
  allowedDevOrigins: ["*.localhost"],
  // The e2e dev server builds into its own folder (playwright.config.ts) so it can run beside `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The catalog import (src/server/catalog/import/actions.ts) sends the file base64-encoded to a
  // Server Action: 5,000,000 bytes become ~6.7 MB of text, plus the request's own overhead.
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
