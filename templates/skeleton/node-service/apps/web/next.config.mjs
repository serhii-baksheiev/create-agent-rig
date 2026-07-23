/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: one build, no second runtime — the API server (or a CDN)
  // serves the bundle. See README for how this target serves it.
  output: 'export',
  // The core ships as TypeScript source; Next transpiles it for the browser.
  transpilePackages: ['@app/core'],
  // The core uses NodeNext-style relative imports ("./note.js" resolving to
  // note.ts). Turbopack cannot map that, so the build runs webpack (see the
  // build script) with the standard extension alias.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default nextConfig;
