export interface Chunk {
  ord: number;
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Splits text into ~`target` character chunks on structural boundaries (headings, blank lines,
 * then lines) and records line ranges so every claim can cite `path:start-end`.
 */
export function chunkText(text: string, target = 1200, hardMax = 2400): Chunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let start = 1;

  const flush = (endLine: number) => {
    const body = buf.join("\n").trim();
    if (body) chunks.push({ ord: chunks.length, text: body, startLine: start, endLine });
    buf = [];
    bufLen = 0;
    start = endLine + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const isHeading = /^#{1,6}\s/.test(line) || /^(class|def|function|export|public|func|fn)\s/.test(line);
    if (isHeading && bufLen >= target / 3) flush(lineNo - 1);
    if (line.length > hardMax) {
      // Minified or single-line content: split the line itself.
      if (bufLen > 0) flush(lineNo - 1);
      for (let off = 0; off < line.length; off += target) {
        chunks.push({ ord: chunks.length, text: line.slice(off, off + target), startLine: lineNo, endLine: lineNo });
      }
      start = lineNo + 1;
      continue;
    }
    buf.push(line);
    bufLen += line.length + 1;
    const blank = line.trim() === "";
    if ((bufLen >= target && blank) || bufLen >= hardMax) flush(lineNo);
  }
  flush(lines.length);
  return chunks;
}
