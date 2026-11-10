export interface Part { name: string; value?: string; filename?: string; content?: Buffer; contentType?: string }

export function buildMultipart(parts: Part[]): { payload: Buffer; headers: { 'content-type': string } } {
  const boundary = '----vimantest' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.filename !== undefined) head += `Content-Type: ${p.contentType ?? 'application/octet-stream'}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(p.content ?? Buffer.from(p.value ?? '', 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
