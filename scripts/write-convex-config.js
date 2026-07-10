// Run as part of the Vercel build (see vercel.json) after `npx convex
// deploy` has set CONVEX_URL for this specific deploy - production and
// every preview deployment each get their own value here, since Convex
// provisions a fresh, isolated backend per preview deployment.
const fs = require("fs");
const path = require("path");

const url = process.env.CONVEX_URL;
if (!url) {
  console.error("CONVEX_URL is not set - was this run after `npx convex deploy`?");
  process.exit(1);
}

const outPath = path.join(__dirname, "..", "public", "js", "convex-config.js");
const contents = `// Auto-generated at build time by scripts/write-convex-config.js - do not edit directly.
(function () {
  window.NSAA_CONVEX_CONFIG = {
    url: ${JSON.stringify(url)},
  };
})();
`;

fs.writeFileSync(outPath, contents);
console.log(`Wrote ${outPath} with CONVEX_URL=${url}`);
