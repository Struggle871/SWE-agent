import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface SkillMetadata { id: string; name: string; description: string; path: string; body: string; bodyHash: string; }
export interface ContextFragment { role: "user" | "developer"; type: "agents_md.instructions" | "skills.catalog" | "skills.body"; source: string; text: string; hash: string; }

export function discoverSkills(cwd: string): SkillMetadata[] {
  const roots = [path.join(path.resolve(cwd), ".codex", "skills"), path.join(path.resolve(cwd), ".agents", "skills")];
  const result: SkillMetadata[] = [];
  for (const root of roots) walk(root, 0, result);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export function loadSkillFragments(cwd: string, selectedMentions: readonly string[] = []): ContextFragment[] {
  const skills = discoverSkills(cwd);
  const catalog = skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`).join("\n");
  const fragments: ContextFragment[] = [];
  if (catalog) fragments.push(fragment("developer", "skills.catalog", path.resolve(cwd), catalog));
  for (const skill of skills.filter((candidate) => selectedMentions.includes(candidate.name) || selectedMentions.includes(candidate.path))) fragments.push(fragment("user", "skills.body", skill.path, `<skill name="${skill.name}">\n${skill.body}\n</skill>`));
  return fragments;
}

function walk(dir: string, depth: number, result: SkillMetadata[]): void {
  if (depth > 6 || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || path.basename(dir).startsWith(".")) return;
  const skillPath = path.join(dir, "SKILL.md");
  if (fs.existsSync(skillPath) && fs.statSync(skillPath).isFile()) {
    try {
      const body = fs.readFileSync(skillPath, "utf8");
      const parsed = parseSkill(body, path.basename(dir));
      result.push({ id: path.resolve(skillPath), name: parsed.name, description: parsed.description, path: path.resolve(skillPath), body, bodyHash: hash(body) });
    } catch { /* invalid skills are isolated from session startup */ }
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith(".")) walk(path.join(dir, entry.name), depth + 1, result);
}

function parseSkill(body: string, fallbackName: string): { name: string; description: string } {
  if (!body.startsWith("---")) throw new Error("SKILL.md frontmatter missing");
  const end = body.indexOf("\n---", 3); if (end < 0) throw new Error("SKILL.md frontmatter invalid");
  const fields = Object.fromEntries(body.slice(3, end).split(/\r?\n/).filter(Boolean).map((line) => { const i = line.indexOf(":"); return i > 0 ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] : ["", ""]; }));
  const name = fields.name || fallbackName; const description = fields.description;
  if (!description || name.length > 64) throw new Error("SKILL.md metadata invalid");
  return { name, description };
}

function fragment(role: "user" | "developer", type: ContextFragment["type"], source: string, text: string): ContextFragment { return { role, type, source, text, hash: hash(text) }; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
