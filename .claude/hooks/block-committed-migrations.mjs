// PreToolUse hook that enforces hard rule 7 (migrations are append-only).
// It blocks Edit, MultiEdit and Write on any file in a `migrations/` directory that
// already exists in HEAD. New, uncommitted migrations can still be edited.
// Exit code 2 blocks the tool call and shows stderr to Claude.
import { execFileSync } from "node:child_process";
import path from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const filePath = JSON.parse(input).tool_input?.file_path;
if (!filePath) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const rel = path.relative(root, path.resolve(root, filePath)).split(path.sep).join("/");
if (rel.startsWith("../") || !rel.split("/").slice(0, -1).includes("migrations")) process.exit(0);

try {
  execFileSync("git", ["cat-file", "-e", `HEAD:${rel}`], { cwd: root, stdio: "ignore" });
} catch {
  process.exit(0); // not in HEAD (new migration, or no commits yet)
}

console.error(
  `Blocked: ${rel} is a committed migration, and migrations are append-only (CLAUDE.md hard rule 7). ` +
    "Add a new migration instead.",
);
process.exit(2);
