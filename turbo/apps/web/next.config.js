/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Skip type checking during build - types are verified in CI lint job
    ignoreBuildErrors: true,
  },
  eslint: {
    // Skip linting during build - linting is done in CI lint job
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
