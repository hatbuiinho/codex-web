import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { glob } from "glob";

export async function imageContextBytes(
  lines: AsyncIterable<string>,
): Promise<number> {
  let bytes = 0;
  for await (const line of lines) {
    // Rollouts are append-only. Compaction replaces the working history, not
    // the transcript. Count only the image payload still in working context.
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    } // partial last line
    if (record.type === "compacted") {
      bytes = 0;
      for (const match of JSON.stringify(
        record.payload?.replacement_history ?? [],
      ).matchAll(/data:image\/[^;"\s]+;base64,([A-Za-z0-9+/=]+)/g))
        bytes += match[1]!.length;
    } else if (record.type === "response_item") {
      for (const match of line.matchAll(
        /data:image\/[^;"\s]+;base64,([A-Za-z0-9+/=]+)/g,
      ))
        bytes += match[1]!.length;
    }
  }
  return bytes;
}

export async function getThreadImageContext(
  codexHome: string,
  threadId: string,
) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId))
    throw new Error("Invalid thread ID");
  const files = await glob(`sessions/**/rollout-*-${threadId}.jsonl`, {
    cwd: codexHome,
    nodir: true,
  });
  if (files.length !== 1) return { available: false, imageBytes: 0 };
  const input = createReadStream(path.join(codexHome, files[0]!), {
    encoding: "utf8",
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    return { available: true, imageBytes: await imageContextBytes(lines) };
  } finally {
    lines.close();
    input.destroy();
  }
}
