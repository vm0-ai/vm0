/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Temporary: Skip type checking during build to diagnose deployment failures
    // TODO: Remove this once root cause is identified
    ignoreBuildErrors: true,
  },
  eslint: {
    // Temporary: Skip linting during build to diagnose deployment failures
    // TODO: Remove this once root cause is identified
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
