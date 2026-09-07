import path from "node:path";
import type { NextConfig } from "next";

/**
 * The explorer reads the committed pipeline artifacts (`artifacts/run-history.json`,
 * `artifacts/runs/<runId>/{manifest,coverage,verification}.json`) with `fs` in
 * server components. They live two directories above this app, so they must be
 * traced into the serverless bundle explicitly.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  typedRoutes: false,
  outputFileTracingRoot: path.join(__dirname, "../../"),
  outputFileTracingIncludes: {
    "/**": ["../../artifacts/run-history.json", "../../artifacts/runs/**/*.json"],
  },
  serverExternalPackages: ["@modelcontextprotocol/sdk"],
  transpilePackages: ["@osceola/shared"],
};

export default nextConfig;
