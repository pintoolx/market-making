import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Deployed on Vercel (moved off Zeabur). Vercel handles the build output
  // natively, so `output: "standalone"` (which was for the Zeabur Docker image)
  // is no longer needed. Re-add it only if self-hosting via the Dockerfile again.
};

export default nextConfig;
