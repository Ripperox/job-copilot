// Reading a résumé out of a file the user drops in.
//
// The onboarding used to open on an empty textarea saying "paste your full
// resume text here". That is the highest-friction moment in the whole product:
// a wall of nothing, asking for a chunk of writing the user has to go and find,
// open, select and copy. Every job tool on the market takes a file, and the one
// the user already has is a PDF.

export const ACCEPTED = '.pdf,.txt,.md,.markdown,text/plain,application/pdf';

/** Ten megabytes. A résumé that exceeds this is not a résumé. */
const MAX_BYTES = 10 * 1024 * 1024;

export class ResumeFileError extends Error {}

function tidy(text: string): string {
  return text
    // PDF extraction often gives one text item per word; collapse the runs of
    // spaces that leaves behind without destroying paragraph breaks.
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

async function readPdf(file: File): Promise<string> {
  // Loaded on demand. pdf.js is ~350KB and most sessions never touch it, so it
  // has no business in the main bundle.
  const pdfjs = await import('pdfjs-dist');
  // Vite resolves this to a hashed asset URL at build time; without it pdf.js
  // tries to fetch a worker from a CDN, which the CSP would block.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;

  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    // Insert a newline when the vertical position moves, so lines survive.
    let lastY: number | null = null;
    let line = '';
    const out: string[] = [];
    for (const item of content.items as { str: string; transform: number[] }[]) {
      const y = item.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        out.push(line);
        line = '';
      }
      line += item.str;
      lastY = y;
    }
    if (line) out.push(line);
    pages.push(out.join('\n'));
  }
  return tidy(pages.join('\n\n'));
}

/**
 * Extract résumé text from a dropped or chosen file.
 *
 * Throws ResumeFileError with a message written for a person, because these
 * failures are all things the user can act on — wrong file, too big, a scanned
 * PDF with no text layer.
 */
export async function readResumeFile(file: File): Promise<string> {
  if (file.size > MAX_BYTES) {
    throw new ResumeFileError('That file is over 10MB. A résumé should be far smaller.');
  }

  const name = file.name.toLowerCase();
  const isPdf = file.type === 'application/pdf' || name.endsWith('.pdf');
  const isText = /\.(txt|md|markdown)$/.test(name) || file.type.startsWith('text/');

  if (name.endsWith('.docx') || name.endsWith('.doc')) {
    // Worth naming specifically: it is the second most likely file someone
    // reaches for, and "unsupported file" would leave them guessing.
    throw new ResumeFileError(
      'Word files are not supported. Export it as PDF, or paste the text below.',
    );
  }
  if (!isPdf && !isText) {
    throw new ResumeFileError('Use a PDF or a plain text file, or paste the text below.');
  }

  const text = isPdf ? await readPdf(file) : tidy(await file.text());

  if (text.length < 200) {
    throw new ResumeFileError(
      isPdf
        ? 'No text could be read from that PDF — it may be a scan or an image. Paste the text below instead.'
        : 'That file looks almost empty. Check it is the right one, or paste the text below.',
    );
  }
  return text;
}
