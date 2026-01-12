import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  typescript: {
    // Skip type checking during build - types are verified in CI lint job
    ignoreBuildErrors: true,
  },
  eslint: {
    // Skip linting during build - linting is done in CI lint job
    ignoreDuringBuilds: true,
  },
};

export default withMDX(config);
