import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Deployed to Cloudflare Pages as a fully static site. The app has no API
  // routes / server actions, so it exports to plain HTML in `out/`.
  output: "export",
  // Static export can't use Next's image optimization server, so serve images
  // as-is. Fine for now; revisit if we need optimized/responsive images.
  images: { unoptimized: true },
};

export default nextConfig;
