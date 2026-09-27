#!/usr/bin/env node
// Syncs the single source of truth in shared/ into every managed skill.
//
// A skill is "managed" when its SKILL.md contains at least one generated region.
// For each managed skill this script:
//   1. copies the shared reference files into <skill>/references/, and
//   2. fills every `<!-- BEGIN GENERATED: shared/<file> -->` ... `<!-- END GENERATED: shared/<file> -->`
//      region found in the skill's Markdown files with the current content of shared/<file>.
//
// Usage:
//   node scripts/build.mjs          write the generated content
//   node scripts/build.mjs --check  exit 1 if any generated content is out of date (used in CI)

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_DIR = join(ROOT, "shared");
const SKILLS_DIR = join(ROOT, "skills");

// Shared files copied verbatim into <skill>/references/.
const SHARED_REFERENCES = ["ddd.md", "rest-api.md", "solid-patterns.md", "testing-strategy.md"];

const REGION = /(<!-- BEGIN GENERATED: shared\/([\w.-]+) -->\n)[\s\S]*?(<!-- END GENERATED: shared\/\2 -->)/g;

const checkOnly = process.argv.includes("--check");

const readShared = (name) => {
  const path = join(SHARED_DIR, name);
  if (!existsSync(path)) throw new Error(`Missing shared source: shared/${name}`);
  return readFileSync(path, "utf8").trimEnd() + "\n";
};

const markdownFiles = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return entry.endsWith(".md") ? [path] : [];
  });

const managedSkills = () =>
  readdirSync(SKILLS_DIR)
    .map((name) => join(SKILLS_DIR, name))
    .filter((dir) => {
      const skillFile = join(dir, "SKILL.md");
      return existsSync(skillFile) && readFileSync(skillFile, "utf8").includes("<!-- BEGIN GENERATED: shared/");
    });

const copyHeader = (name) =>
  `<!-- GENERATED from shared/${name} by scripts/build.mjs. Edit the source, not this file. -->\n\n`;

const expectedFiles = (skillDir) => {
  const files = new Map();

  for (const name of SHARED_REFERENCES) {
    files.set(join(skillDir, "references", name), copyHeader(name) + readShared(name));
  }

  for (const path of markdownFiles(skillDir)) {
    if (files.has(path)) continue;
    const current = readFileSync(path, "utf8");
    const filled = current.replace(REGION, (_match, begin, name, end) => begin + readShared(name) + end);
    files.set(path, filled);
  }

  return files;
};

const stale = [];

for (const skillDir of managedSkills()) {
  for (const [path, content] of expectedFiles(skillDir)) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === content) continue;
    stale.push(relative(ROOT, path));
    if (!checkOnly) writeFileSync(path, content);
  }
}

if (checkOnly && stale.length > 0) {
  console.error("Generated content is out of date. Run `node scripts/build.mjs` and commit the result:");
  for (const path of stale) console.error(`  - ${path}`);
  process.exit(1);
}

console.log(checkOnly ? "Generated content is up to date." : `Updated ${stale.length} file(s).`);
for (const path of checkOnly ? [] : stale) console.log(`  - ${path}`);
