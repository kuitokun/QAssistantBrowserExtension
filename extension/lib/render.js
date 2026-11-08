// Draws annotations. The editor, the document preview and the .docx export
// all use this file, so a screenshot looks the same in all three.

export const COLORS = ['#e5262b', '#f97316', '#facc15', '#16a34a', '#2563eb', '#111827'];
const FONT = '"Segoe UI", Arial, sans-serif';
const TEXT_SCALE = { s: [0.012, 15], m: [0.016, 20], l: [0.023, 28] };

export const strokeWidth = (imageWidth) => Math.max(3, Math.round(imageWidth / 450));

export function fontSize(annotation, imageWidth) {
  const [ratio, minimum] = TEXT_SCALE[annotation.size] || TEXT_SCALE.m;
  return Math.max(minimum, Math.round(imageWidth * ratio));
}

function textColorOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const luminance = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luminance > 150 ? '#111827' : '#ffffff';
}

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function measureText(ctx, annotation, imageWidth) {
  const size = fontSize(annotation, imageWidth);
  ctx.save();
  ctx.font = `600 ${size}px ${FONT}`;
  const lines = wrapLines(ctx, annotation.text, Math.max(imageWidth * 0.42, size * 10));
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width), size);
  ctx.restore();
  const pad = Math.round(size * 0.55);
  const lineHeight = Math.round(size * 1.3);
  return { lines, size, pad, lineHeight, w: Math.ceil(width) + pad * 2, h: lines.length * lineHeight + pad * 2 };
}

function drawHighlight(ctx, a) {
  ctx.save();
  ctx.fillStyle = a.color;
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.8;
  ctx.fillRect(a.x, a.y, a.w, a.h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.14; // keeps the highlight visible on dark pages
  ctx.fillRect(a.x, a.y, a.w, a.h);
  ctx.restore();
}

function drawArrow(ctx, a, imageWidth) {
  const width = strokeWidth(imageWidth);
  const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const length = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
  const head = Math.min(width * 4.5, length * 0.6);
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = a.color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x1, a.y1);
  ctx.lineTo(a.x2 - Math.cos(angle) * head * 0.8, a.y2 - Math.sin(angle) * head * 0.8);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(a.x2, a.y2);
  ctx.lineTo(a.x2 - head * Math.cos(angle - 0.45), a.y2 - head * Math.sin(angle - 0.45));
  ctx.lineTo(a.x2 - head * Math.cos(angle + 0.45), a.y2 - head * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawText(ctx, a, imageWidth) {
  const m = measureText(ctx, a, imageWidth);
  ctx.save();
  ctx.fillStyle = a.color;
  ctx.shadowColor = 'rgba(0,0,0,.28)';
  ctx.shadowBlur = m.size * 0.35;
  ctx.shadowOffsetY = m.size * 0.08;
  ctx.beginPath();
  ctx.roundRect(a.x, a.y, m.w, m.h, m.size * 0.28);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = textColorOn(a.color);
  ctx.font = `600 ${m.size}px ${FONT}`;
  ctx.textBaseline = 'middle';
  m.lines.forEach((line, i) => {
    ctx.fillText(line, a.x + m.pad, a.y + m.pad + m.lineHeight * (i + 0.5));
  });
  ctx.restore();
}

export function drawAnnotation(ctx, a, imageWidth) {
  if (a.type === 'highlight') drawHighlight(ctx, a);
  else if (a.type === 'box') {
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.lineWidth = strokeWidth(imageWidth);
    ctx.strokeRect(a.x, a.y, a.w, a.h);
    ctx.restore();
  } else if (a.type === 'redact') {
    ctx.save();
    ctx.fillStyle = '#111827';
    ctx.fillRect(a.x, a.y, a.w, a.h);
    ctx.restore();
  } else if (a.type === 'arrow') drawArrow(ctx, a, imageWidth);
  else if (a.type === 'text') drawText(ctx, a, imageWidth);
}

export function drawAnnotations(ctx, annotations, imageWidth) {
  for (const a of annotations) drawAnnotation(ctx, a, imageWidth);
}

// Returns a bitmap with the annotations burned in. Only this flattened image
// ever goes into the .docx, so hidden (redacted) areas are really removed.
export async function flatten(step) {
  const bitmap = await createImageBitmap(step.image);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  drawAnnotations(ctx, step.annotations || [], bitmap.width);
  bitmap.close();
  return canvas;
}

export async function thumbnail(step, width = 720) {
  const full = await flatten(step);
  const scale = Math.min(1, width / full.width);
  const height = Math.min(Math.round(full.height * scale), 1400);
  const canvas = new OffscreenCanvas(Math.round(full.width * scale), height);
  canvas.getContext('2d').drawImage(full, 0, 0, full.width, height / scale, 0, 0, canvas.width, height);
  return canvas.convertToBlob({ type: 'image/png' });
}
