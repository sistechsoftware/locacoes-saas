/** @type {import('next').NextConfig} */
const nextConfig = {
  // necessario para o opennextjs-cloudflare empacotar o app para o Workers
  output: "standalone",
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  experimental: {
    serverActions: { bodySizeLimit: "12mb" },
  },
};
export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
