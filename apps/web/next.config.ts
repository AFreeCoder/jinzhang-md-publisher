import type { NextConfig } from 'next';
const config: NextConfig = {
  // Vercel 使用自己的构建适配器；standalone 仅用于自托管的 Docker 镜像。
  output: process.env.VERCEL === '1' ? undefined : 'standalone',
  outputFileTracingRoot: process.cwd() + '/../..',
  transpilePackages: ['@jinzhang/core'],
  poweredByHeader: false,
  serverExternalPackages: ['ali-oss', 'sharp'],
};
export default config;
