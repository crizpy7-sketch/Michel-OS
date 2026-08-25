import type { NextConfig } from 'next';

const config: NextConfig = {
  // The domain layer is written for Node's native type-stripping, so its
  // imports carry explicit .ts extensions. Webpack resolves those literally,
  // which is exactly what we want: one set of source files serves both
  // `node --test` and the Next build, with no duplicate module graph.
  serverExternalPackages: ['node:sqlite'],
  experimental: {
    typedRoutes: false,
  },
};

export default config;
