import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The alert template is read from disk at runtime, so ship it with the serverless function.
  outputFileTracingIncludes: {
    "/api/slack/events": ["./templates/**/*"],
  },
};

export default nextConfig;
