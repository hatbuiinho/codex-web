import { readFile, writeFile } from "node:fs/promises";

const target = process.argv[2];

if (!target) {
  throw new Error("Usage: node scripts/patch_upstream_files_pdf.mjs <upstream-bundle>");
}

const source = await readFile(target, "utf8");
const marker = "/* codex-web:continuous-files-pdf */";

if (source.includes(marker)) {
  throw new Error(`Upstream Files/PDF patch is already present in ${target}`);
}

function replaceOnce(input, before, after, description) {
  const first = input.indexOf(before);
  if (first === -1 || input.indexOf(before, first + before.length) !== -1) {
    throw new Error(
      `Unable to apply Files/PDF patch: expected exactly one ${description}. ` +
        "The upstream bundle changed; update this patch before releasing.",
    );
  }
  return `${input.slice(0, first)}${after}${input.slice(first + before.length)}`;
}

let patched = source;

// The desktop Files preview uses react-pdf's single <Page>, which is why its
// UI has previous/next controls. Render every page in the same scroll parent
// instead. The separate task-link PDF renderer already behaves this way.
patched = replaceOnce(
  patched,
  "children:(0,WV.jsx)(nPt,{className:q(`overflow-hidden rounded-sm shadow-sm`),pageNumber:d,width:r!=null&&r>0?r:void 0,renderAnnotationLayer:!1,renderTextLayer:!1})",
  "children:/* codex-web:continuous-files-pdf */Array.from({length:u??0},(e,t)=>(0,WV.jsx)(nPt,{className:q(`mb-4 overflow-hidden rounded-sm shadow-sm`),pageNumber:t+1,width:r!=null&&r>0?r:void 0,renderAnnotationLayer:!1,renderTextLayer:!1},t+1))",
  "single-page PDF renderer",
);

// This bundle is compiled with React Compiler memo slots. Include numPages in
// the cache key, otherwise the tree initially renders zero pages and remains
// cached after PDF.js discovers its page count.
patched = replaceOnce(
  patched,
  "t[3]!==d||t[4]!==r||t[5]!==n.dataUrl",
  "t[3]!==`${d}:${u??0}`||t[4]!==r||t[5]!==n.dataUrl",
  "PDF preview cache condition",
);
patched = replaceOnce(
  patched,
  "t[1]=l,t[2]=m,t[3]=d,t[4]=r,t[5]=n.dataUrl",
  "t[1]=l,t[2]=m,t[3]=`${d}:${u??0}`,t[4]=r,t[5]=n.dataUrl",
  "PDF preview cache assignment",
);

// Pager actions no longer describe the continuous document. Keep dPt intact
// (it is shared by this compiled module) but hide its controls for Files.
patched = replaceOnce(
  patched,
  "showPager:p},e[4]=f",
  "showPager:!1},e[4]=f",
  "Files PDF pager setting",
);

await writeFile(target, patched);
console.log(`Applied continuous Files PDF preview patch to ${target}`);
