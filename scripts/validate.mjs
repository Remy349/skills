#!/usr/bin/env node
// Structural checks for every skill in skills/:
//   - SKILL.md exists and has `name` and `description` frontmatter
//   - `name` matches the folder name and uses lowercase letters, digits and hyphens
//   - `description` is at most 1024 characters
//   - SKILL.md stays under 500 lines (context budget)
//   - every `references/...` path mentioned in SKILL.md and every relative Markdown link exists

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(ROOT, "skills");
const MAX_DESCRIPTION = 1024;
const MAX_SKILL_LINES = 500;

const errors = [];
const fail = (file, message) => errors.push(`${relative(ROOT, file)}: ${message}`);

const markdownFiles = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return entry.endsWith(".md") ? [path] : [];
  });

const parseFrontmatter = (text) => {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const fields = {};
  let currentKey = null;
  for (const line of match[1].split("\n")) {
    const keyMatch = line.match(/^([a-z-]+):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      fields[currentKey] = keyMatch[2];
    } else if (currentKey && /^\s+/.test(line)) {
      fields[currentKey] += " " + line.trim();
    }
  }
  return fields;
};

const withoutCodeBlocks = (text) => text.replace(/```[\s\S]*?```/g, "");

for (const name of readdirSync(SKILLS_DIR)) {
  const skillDir = join(SKILLS_DIR, name);
  if (!statSync(skillDir).isDirectory()) continue;

  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) {
    fail(skillDir, "missing SKILL.md");
    continue;
  }

  const text = readFileSync(skillFile, "utf8");
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter) {
    fail(skillFile, "missing YAML frontmatter");
  } else {
    if (frontmatter.name !== name) fail(skillFile, `name "${frontmatter.name}" must match folder "${name}"`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(frontmatter.name ?? "")) fail(skillFile, "name must be kebab-case");
    const description = frontmatter.description ?? "";
    if (!description) fail(skillFile, "missing description");
    if (description.length > MAX_DESCRIPTION) {
      fail(skillFile, `description has ${description.length} characters (max ${MAX_DESCRIPTION})`);
    }
  }

  const lines = text.split("\n").length;
  if (lines > MAX_SKILL_LINES) fail(skillFile, `${lines} lines (max ${MAX_SKILL_LINES})`);

  for (const [, path] of withoutCodeBlocks(text).matchAll(/`(references\/[\w./-]+\.md)`/g)) {
    if (!existsSync(join(skillDir, path))) fail(skillFile, `mentions missing file ${path}`);
  }

  for (const file of markdownFiles(skillDir)) {
    for (const [, target] of withoutCodeBlocks(readFileSync(file, "utf8")).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      if (!existsSync(resolve(dirname(file), target))) fail(file, `broken link ${target}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("All skills are valid.");
