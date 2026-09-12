import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Deployed to Cloudflare Pages as a fully static site. The app has no API
  // routes / server actions, so it exports to plain HTML in `out/`.
  output: "export",
  // Local maintenance pages are excluded from production route discovery.
  pageExtensions: process.env.NODE_ENV === "development"
    ? ["dev.tsx", "tsx", "ts", "jsx", "js"]
    : ["tsx", "ts", "jsx", "js"],
  // Static export can't use Next's image optimization server, so serve images
  // as-is. Fine for now; revisit if we need optimized/responsive images.
  images: { unoptimized: true },
};

export default nextConfig;
