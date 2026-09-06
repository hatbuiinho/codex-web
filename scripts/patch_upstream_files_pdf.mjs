import { readFile, writeFile } from "node:fs/promises";

const target = process.argv[2];

if (!target) {
  throw new Error("Usage: node scripts/patch_upstream_files_pdf.mjs <upstream-bundle>");
}

const source = await readFile(target, "utf8");
const marker = "/* codex-web:files-use-artifact-pdf */";

if (source.includes(marker)) {
  throw new Error(`Upstream Files/PDF patch is already present in ${target}`);
}

function replaceOnce(input, pattern, after, description) {
  const matches = [...input.matchAll(pattern)];
  if (matches.length !== 1 || matches[0].index === undefined) {
    throw new Error(
      `Unable to apply Files/PDF patch: expected exactly one ${description}. ` +
        "The upstream bundle changed; update this patch before releasing.",
    );
  }
  const match = matches[0];
  return `${input.slice(0, match.index)}${after}${input.slice(
    match.index + match[0].length,
  )}`;
}

let patched = source;

// Files normally opens every selected path through its generic file viewer.
// Route PDFs through the existing Artifact tab instead: it lazily loads
// PdfPreviewPanel, the same upstream continuous-scroll renderer used when a
// PDF link is opened from a task message.
patched = replaceOnce(
  patched,
  /ie\s*=\s*\(\s*e\s*,\s*t\s*\)\s*=>\s*\{\s*if\s*\(\s*s\s*!=\s*null\s*\)\s*\{\s*s\s*\(\s*js\s*\(\s*i\s*,\s*e\s*\)\s*,\s*t\s*\)\s*;?\s*return\s*;?\s*}\s*_\.mutate\s*\(\s*\{\s*cwd\s*:\s*y\s*,\s*path\s*:\s*e\s*}\s*\)\s*;?\s*}/g,
  "ie=(e,t)=>{let n=js(i,e);if(e.toLowerCase().endsWith(`.pdf`)&&aM(l,n,{hostId:o}))return;/* codex-web:files-use-artifact-pdf */if(s!=null){s(n,t);return}_.mutate({cwd:y,path:e})}",
  "Files file-open handler",
);

await writeFile(target, patched);
console.log(`Routed Files PDFs through the upstream Artifact preview in ${target}`);
