#!/usr/bin/env node
/**
 * Extract RSC (React Server Components) flight data from Mintlify static export HTML files
 * and save as separate .rsc files for client-side navigation support.
 *
 * Usage: node scripts/generate-rsc.js <static-dir>
 */

const fs = require("fs");
const path = require("path");

const staticDir = process.argv[2];
if (!staticDir) {
  console.error("Usage: node scripts/generate-rsc.js <static-dir>");
  process.exit(1);
}

if (!fs.existsSync(staticDir)) {
  console.error(`Directory not found: ${staticDir}`);
  process.exit(1);
}

const RSC_PUSH_RE = /<script>self\.__next_f\.push\((\[.+?\])\)<\/script>/g;

function extractRscData(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf-8");
  let rscData = "";
  let m;
  while ((m = RSC_PUSH_RE.exec(html))) {
    try {
      const arr = JSON.parse(m[1]);
      if (arr[0] === 1 && typeof arr[1] === "string") {
        rscData += arr[1];
      }
    } catch {
      // skip malformed chunks
    }
  }
  RSC_PUSH_RE.lastIndex = 0; // reset regex state
  return rscData;
}

function findHtmlFiles(dir, base = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip _next and other internal directories
      if (entry.name.startsWith("_") || entry.name === "node_modules") continue;
      results.push(...findHtmlFiles(fullPath, base));
    } else if (entry.name === "index.html") {
      results.push(fullPath);
    }
  }
  return results;
}

const htmlFiles = findHtmlFiles(staticDir);
let generated = 0;

for (const htmlFile of htmlFiles) {
  const rscData = extractRscData(htmlFile);
  if (!rscData) continue;

  // Save .rsc file next to the index.html
  const rscFile = path.join(path.dirname(htmlFile), "index.rsc");
  fs.writeFileSync(rscFile, rscData, "utf-8");
  generated++;

  const rel = path.relative(staticDir, rscFile);
  console.log(`[RSC] ${rel} (${rscData.length} bytes)`);
}

console.log(`[RSC] Generated ${generated} RSC files from ${htmlFiles.length} HTML files.`);
