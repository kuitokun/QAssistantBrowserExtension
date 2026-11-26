// Builds a PDF with the same layout as the Word document: title, then each
// step's heading, notes and screenshots. Written by hand so the extension
// keeps working with no outside code. Screenshots are stored losslessly.
import { imagesForStep, roomOnFirstPage, formatDate, stepTitle, fileName, TITLE_BLOCK } from './docx.js';

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;
const MARGIN = 54; // 0.75 inch, as in the Word document
const BOTTOM = PAGE_H - MARGIN;
const CONTENT_W = PAGE_W - MARGIN * 2;
const PT = 72; // points per inch

// Character widths of the standard PDF fonts for codes 32 to 255 (WinAnsi).
const WIDTHS = {
  F1: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500],
  F2: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556],
};

// Unicode to WinAnsi (Windows-1252) codes; characters outside it become '?'.
const WIN_ANSI = (() => {
  const map = new Map();
  const chars = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 224 }, (_, i) => i + 32));
  [...chars].forEach((char, i) => map.set(char, i + 32));
  return map;
})();

const encode = (text) => [...String(text ?? '')].map((char) => WIN_ANSI.get(char) ?? 63);

function textWidth(text, font, size) {
  return encode(text).reduce((sum, code) => sum + WIDTHS[font][code - 32], 0) * size / 1000;
}

function pdfString(text) {
  let out = '(';
  for (const code of encode(text)) {
    if (code === 40 || code === 41 || code === 92) out += '\\' + String.fromCharCode(code);
    else if (code < 127) out += String.fromCharCode(code);
    else out += '\\' + code.toString(8).padStart(3, '0');
  }
  return out + ')';
}

function wrap(text, font, size, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(candidate, font, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    // A single word wider than the page is broken by characters.
    while (textWidth(line, font, size) > maxWidth && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && textWidth(line.slice(0, cut), font, size) > maxWidth) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    lines.push(line);
  }
  return lines;
}

const n = (value) => (Math.round(value * 100) / 100).toString();
const GREY = '0.42 0.45 0.5 rg';
const INK = '0.12 0.16 0.22 rg';

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function rgbPixels(canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return deflate(rgb);
}

class Layout {
  constructor() {
    this.pages = [];
    this.images = [];
    this.newPage();
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = MARGIN;
  }

  get atTop() {
    return this.y === MARGIN;
  }

  ensure(height) {
    if (this.y + height > BOTTOM && !this.atTop) this.newPage();
  }

  text(line, { font = 'F1', size = 11, color = INK, x = MARGIN, lineHeight = size * 1.3 } = {}) {
    this.ensure(lineHeight);
    const baseline = PAGE_H - (this.y + lineHeight * 0.78);
    this.ops.push(`BT ${color} /${font} ${n(size)} Tf ${n(x)} ${n(baseline)} Td ${pdfString(line)} Tj ET`);
    this.y += lineHeight;
  }

  rule(color = '0.82 0.84 0.86') {
    this.ops.push(`${color} RG 0.75 w ${n(MARGIN)} ${n(PAGE_H - this.y)} m ${n(MARGIN + CONTENT_W)} ${n(PAGE_H - this.y)} l S`);
  }

  image(name, width, height) {
    if (height > BOTTOM - MARGIN) {
      width *= (BOTTOM - MARGIN) / height;
      height = BOTTOM - MARGIN;
    }
    this.ensure(height + 4);
    const bottom = PAGE_H - this.y - height;
    this.ops.push(`q ${n(width)} 0 0 ${n(height)} ${n(MARGIN)} ${n(bottom)} cm /${name} Do Q`);
    this.ops.push(`0.75 0.77 0.81 RG 0.5 w ${n(MARGIN)} ${n(bottom)} ${n(width)} ${n(height)} re S`);
    this.y += height + 10;
  }
}

export async function buildPdf(meta, steps, onProgress = () => {}) {
  const title = meta.title.trim() || 'Test document';
  const count = `${steps.length} screenshot${steps.length === 1 ? '' : 's'}`;
  const today = new Date().toLocaleDateString(undefined, { dateStyle: 'long' });
  const page = new Layout();

  for (const line of wrap(title, 'F2', 24, CONTENT_W)) page.text(line, { font: 'F2', size: 24, lineHeight: 30 });
  page.text(`${today} · ${count}`, { size: 11, color: GREY, lineHeight: 18 });
  page.y += 4;
  page.rule();
  page.y += 14;

  const images = [];
  for (let i = 0; i < steps.length; i++) {
    onProgress(i + 1, steps.length);
    const step = steps[i];
    const heading = wrap(stepTitle(step, i), 'F2', 14, CONTENT_W);
    const source = meta.includeSource ? wrap([formatDate(step.capturedAt), step.url].filter(Boolean).join(' · '), 'F1', 8.5, CONTENT_W) : [];
    const notes = (step.notes || '').trim();
    const noteLines = notes ? wrap(notes, 'F1', 11, CONTENT_W) : [];

    const room = roomOnFirstPage(step, meta) - (i === 0 ? TITLE_BLOCK : 0);
    const parts = await imagesForStep(step, meta, room);

    // Keep the heading, notes and the first screenshot together when they fit on one page.
    const gap = page.atTop ? 0 : 16;
    const headerHeight = gap + heading.length * 18 + source.length * 12 + 4 + noteLines.length * 14.5 + (noteLines.length ? 6 : 0);
    const first = parts[0] ? Math.min(parts[0].displayH * PT, BOTTOM - MARGIN) : 0;
    if (page.y + headerHeight + first > BOTTOM && !page.atTop && headerHeight + first <= BOTTOM - MARGIN) page.newPage();
    if (!page.atTop) page.y += 16;

    for (const line of heading) page.text(line, { font: 'F2', size: 14, lineHeight: 18 });
    for (const line of source) page.text(line, { size: 8.5, color: GREY, lineHeight: 12 });
    page.y += 4;
    for (const line of noteLines) page.text(line, { size: 11, lineHeight: 14.5 });
    if (noteLines.length) page.y += 6;

    for (const part of parts) {
      const name = `Im${images.length + 1}`;
      images.push({ name, width: part.canvas.width, height: part.canvas.height, data: await rgbPixels(part.canvas) });
      page.image(name, part.displayW * PT, part.displayH * PT);
    }
  }

  return writePdf(title, page.pages, images);
}

async function writePdf(title, pages, images) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id, body, stream) => {
    offsets[id] = length;
    if (stream) {
      push(`${id} 0 obj\n${body.replace('>>', ` /Length ${stream.length} >>`)}\nstream\n`);
      push(stream);
      push('\nendstream\nendobj\n');
    } else push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  // 1 catalog, 2 page tree, 3 and 4 fonts, 5 info, then images, then pages and their contents.
  const imageIds = images.map((_, i) => 6 + i);
  const firstPage = 6 + images.length;
  const pageIds = pages.map((_, i) => firstPage + i * 2);
  const xobjects = images.map((image, i) => `/${image.name} ${imageIds[i]} 0 R`).join(' ');
  const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xobjects} >> >>`;

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const hex = (text) => '<FEFF' + [...text].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '>';
  object(5, `<< /Title ${hex(title)} /Creator (QAssistant) /Producer (QAssistant) >>`);
  images.forEach((image, i) => object(imageIds[i], `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode >>`, image.data));
  for (let i = 0; i < pages.length; i++) {
    const footer = `Page ${i + 1}`;
    const x = MARGIN + CONTENT_W - textWidth(footer, 'F1', 8.5);
    const ops = [...pages[i], `BT ${GREY} /F1 8.5 Tf ${n(x)} ${n(MARGIN / 2)} Td ${pdfString(footer)} Tj ET`];
    const content = await deflate(encoder.encode(ops.join('\n')));
    object(pageIds[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${resources} /Contents ${pageIds[i] + 1} 0 R >>`);
    object(pageIds[i] + 1, '<< /Filter /FlateDecode >>', content);
  }

  const size = firstPage + pages.length * 2;
  const xref = length;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(`${table}trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

export const pdfFilename = (title) => fileName(title, 'pdf');
