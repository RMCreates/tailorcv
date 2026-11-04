// Converts the Markdown result into a Word document (.docx).
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

// Splits a line into runs: **bold**, *italic*, plain.
function inlineRuns(text) {
  const runs = [];
  const re = /\*\*(.+?)\*\*|(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new TextRun(text.slice(last, m.index)));
    if (m[1] !== undefined) runs.push(new TextRun({ text: m[1], bold: true }));
    else runs.push(new TextRun({ text: m[2], italics: true }));
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push(new TextRun(text.slice(last)));
  return runs.length ? runs : [new TextRun("")];
}

export function markdownToParagraphs(md) {
  const out = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const children = [];
    para.forEach((line, i) => {
      if (i) children.push(new TextRun({ break: 1 }));
      children.push(...inlineRuns(line));
    });
    out.push(new Paragraph({ children, spacing: { after: 160 } }));
    para = [];
  };
  for (const raw of String(md || "").split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      const lvl = Math.min(Math.max(m[1].length, 2), 3);
      out.push(new Paragraph({
        children: inlineRuns(m[2].trim()),
        heading: lvl === 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
        spacing: { before: lvl === 2 ? 360 : 240, after: 120 },
      }));
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flush(); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flush();
      out.push(new Paragraph({ children: inlineRuns(m[1]), bullet: { level: 0 }, spacing: { after: 80 } }));
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

export async function markdownToDocx(md, { title = "Tailored resume" } = {}) {
  const doc = new Document({
    title,
    creator: "TailorCV",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 32, bold: true, font: "Calibri", color: "000000" }, paragraph: { spacing: { before: 360, after: 120 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 26, bold: true, font: "Calibri", color: "000000" }, paragraph: { spacing: { before: 240, after: 100 } } },
      ],
    },
    sections: [{ children: markdownToParagraphs(md) }],
  });
  return Packer.toBuffer(doc);
}
