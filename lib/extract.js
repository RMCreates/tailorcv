// Resume file upload: reads one multipart file (PDF or DOCX) and returns its plain text.
import Busboy from "busboy";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

class ExtractError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Reads the first file field from a multipart request into memory (bounded by MAX_FILE_BYTES).
export function readUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_FILE_BYTES, fields: 5, fieldSize: 1024 } });
    } catch {
      return reject(new ExtractError("Please send the file as a multipart form upload."));
    }
    let file = null;
    let tooBig = false;
    bb.on("file", (_name, stream, info) => {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("limit", () => { tooBig = true; stream.resume(); });
      stream.on("end", () => { file = { buffer: Buffer.concat(chunks), filename: info.filename || "", mimeType: info.mimeType || "" }; });
    });
    bb.on("error", (err) => reject(new ExtractError("Couldn't read the upload: " + (err.message || err))));
    bb.on("close", () => {
      if (tooBig) return reject(new ExtractError("That file is too big. Please upload a file under 5 MB."));
      if (!file || !file.buffer.length) return reject(new ExtractError("Please choose a PDF or DOCX file to upload."));
      resolve(file);
    });
    req.pipe(bb);
  });
}

function detectType({ buffer, filename, mimeType }) {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  // DOCX is a zip (PK..) containing word/document.xml
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && (ext === "docx" || /wordprocessingml/.test(mimeType) || buffer.includes("word/"))) return "docx";
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
  if (ext === "docx") return "docx";
  return null;
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/[ \t ]{3,}/g, "  ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractText(file) {
  const type = detectType(file);
  if (!type) throw new ExtractError("Please upload a PDF or Word (.docx) file.");
  let text = "";
  try {
    if (type === "pdf") {
      const parser = new PDFParse({ data: new Uint8Array(file.buffer) });
      try {
        const result = await parser.getText();
        text = result.text;
      } finally {
        await parser.destroy().catch(() => {});
      }
    } else {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      text = result.value;
    }
  } catch (err) {
    throw new ExtractError(type === "pdf"
      ? "We couldn't read that PDF. If it's scanned or password-protected, please paste the text instead."
      : "We couldn't read that Word file. Please save it as .docx again or paste the text instead.");
  }
  text = cleanText(text);
  if (text.length < 20) {
    throw new ExtractError(type === "pdf"
      ? "That PDF doesn't contain selectable text (it may be a scanned image). Please paste the text instead."
      : "That file looks empty. Please paste the text instead.");
  }
  return { text, type };
}

export { ExtractError };
