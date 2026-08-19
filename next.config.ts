import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The landing page template shipped links to /signup, /login, /docs and
   * /enterprise, none of which were ever built. The links now point at real
   * anchors and repo files, but the old paths outlive the change: a tab loaded
   * before the fix still holds the old bundle, and any bookmark or shared URL
   * still names them. Redirecting costs nothing and means none of those ever
   * lands on a 404.
   *
   * Permanent: false, because these are corrections to a page that no longer
   * claims those routes, not a durable URL contract worth caching in browsers.
   */
  async redirects() {
    return [
      { source: "/signup", destination: "/#console", permanent: false },
      { source: "/login", destination: "/#console", permanent: false },
      { source: "/docs", destination: "/#how-it-works", permanent: false },
      { source: "/enterprise", destination: "/#pricing", permanent: false },
    ];
  },
};

export default nextConfig;
