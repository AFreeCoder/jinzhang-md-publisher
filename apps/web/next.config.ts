import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: process.cwd() + '/../..',
  transpilePackages: ['@jinzhang/core'],
  poweredByHeader: false,
  serverExternalPackages: ['ali-oss', 'sharp'],
};
export default config;
