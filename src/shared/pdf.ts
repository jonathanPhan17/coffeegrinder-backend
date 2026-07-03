import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/** Extract raw text + page count from a PDF. Throws on corrupt/encrypted input. */
export async function extractPdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const result = await pdfParse(buffer);
  return { text: result.text, pages: result.numpages };
}
