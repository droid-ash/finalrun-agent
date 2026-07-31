// HTTP artifact streaming for the local report server. Handles byte-range
// requests (for video scrubbing in the browser), directory-traversal guards,
// and content-type mapping. Ported from packages/report-web/src/artifacts.ts
// so the CLI owns the server-side path.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REPORT_CONTENT_TYPES } from './contentTypes.js';

export class ArtifactRangeNotSatisfiableError extends Error {
  readonly size: number;

  constructor(size: number) {
    super('Requested artifact byte range is not satisfiable.');
    this.name = 'ArtifactRangeNotSatisfiableError';
    this.size = size;
  }
}

export function resolveArtifactPath(
  artifactsDir: string,
  relativePath: string,
): string {
  const normalizedRelativePath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolvedPath = path.resolve(artifactsDir, normalizedRelativePath);
  const relativeToArtifacts = path.relative(artifactsDir, resolvedPath);
  if (relativeToArtifacts.startsWith('..') || path.isAbsolute(relativeToArtifacts)) {
    throw new Error('Artifact paths must stay within the workspace artifacts directory.');
  }
  return resolvedPath;
}

export function decodeArtifactPath(rawRelativePath: string): string {
  return rawRelativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment))
    .join('/');
}

export async function serveArtifactHttp(params: {
  artifactsDir: string;
  relativePath: string;
  request: IncomingMessage;
  response: ServerResponse;
}): Promise<void> {
  const { artifactsDir, relativePath, request, response } = params;
  const method = request.method ?? 'GET';
  const headOnly = method === 'HEAD';

  let resolvedPath: string;
  try {
    resolvedPath = resolveArtifactPath(artifactsDir, relativePath);
  } catch (error) {
    writeErrorHtml(response, 404, 'Artifact Not Found', (error as Error).message);
    return;
  }

  let stats;
  try {
    // Symlink containment re-check: resolveArtifactPath above is purely lexical,
    // so a symlink INSIDE the artifacts directory that points OUTSIDE it still
    // passes that check. Re-verifying containment on the realpath of both the
    // root and the resolved path rejects such links, preventing arbitrary file
    // disclosure over the report HTTP stream. Do not drop this in favor of the
    // lexical check alone.
    const artifactsRoot = await fsp.realpath(artifactsDir);
    const realResolvedPath = await fsp.realpath(resolvedPath);
    const relativeToRoot = path.relative(artifactsRoot, realResolvedPath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error('Artifact paths must stay within the workspace artifacts directory.');
    }
    resolvedPath = realResolvedPath;
    stats = await fsp.stat(resolvedPath);
  } catch (error) {
    writeErrorHtml(
      response,
      404,
      'Artifact Not Found',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  if (!stats.isFile()) {
    writeErrorHtml(response, 404, 'Artifact Not Found', `Not a file: ${resolvedPath}`);
    return;
  }

  const rangeHeader = Array.isArray(request.headers.range)
    ? request.headers.range[0]
    : request.headers.range;

  let byteRange: { start: number; end: number } | undefined;
  try {
    byteRange = parseByteRange(rangeHeader, stats.size);
  } catch (error) {
    if (error instanceof ArtifactRangeNotSatisfiableError) {
      response.writeHead(416, {
        'Content-Range': `bytes */${error.size}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(headOnly ? undefined : 'Requested range is not satisfiable.');
      return;
    }
    throw error;
  }

  const contentType =
    REPORT_CONTENT_TYPES[path.extname(resolvedPath).toLowerCase()] ??
    'application/octet-stream';

  if (byteRange) {
    const length = byteRange.end - byteRange.start + 1;
    response.writeHead(206, {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(length),
      'Content-Range': `bytes ${byteRange.start}-${byteRange.end}/${stats.size}`,
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    if (headOnly) {
      response.end();
      return;
    }
    pipeFile(response, resolvedPath, { start: byteRange.start, end: byteRange.end });
    return;
  }

  response.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(stats.size),
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  if (headOnly) {
    response.end();
    return;
  }
  pipeFile(response, resolvedPath);
}

function pipeFile(
  response: ServerResponse,
  resolvedPath: string,
  options?: { start: number; end: number },
): void {
  const stream = fs.createReadStream(resolvedPath, options);
  stream.on('error', (error) => {
    response.destroy(error);
  });
  stream.pipe(response);
}

function parseByteRange(
  rangeHeader: string | undefined,
  totalSize: number,
): { start: number; end: number } | undefined {
  if (!rangeHeader) return undefined;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return undefined;

  const [, startValue, endValue] = match;
  if (startValue === '' && endValue === '') return undefined;

  if (totalSize === 0) {
    throw new ArtifactRangeNotSatisfiableError(totalSize);
  }

  if (startValue === '') {
    const suffixLength = parseInt(endValue, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      throw new ArtifactRangeNotSatisfiableError(totalSize);
    }
    const start = Math.max(0, totalSize - suffixLength);
    return { start, end: totalSize - 1 };
  }

  const start = parseInt(startValue, 10);
  const requestedEnd = endValue === '' ? totalSize - 1 : parseInt(endValue, 10);
  if (!Number.isFinite(start) || !Number.isFinite(requestedEnd)) {
    throw new ArtifactRangeNotSatisfiableError(totalSize);
  }
  if (start < 0 || start >= totalSize) {
    throw new ArtifactRangeNotSatisfiableError(totalSize);
  }

  const end = Math.min(requestedEnd, totalSize - 1);
  if (end < start) {
    throw new ArtifactRangeNotSatisfiableError(totalSize);
  }
  return { start, end };
}

export function renderHtmlErrorPage(params: { title: string; message: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(params.title)}</title>
  <style>
    body {
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", sans-serif;
      background: linear-gradient(180deg, #f8fbff 0%, #f4f7fb 100%);
      color: #1a2740;
    }
    main {
      max-width: 780px;
      margin: 72px auto;
      padding: 0 24px;
    }
    section {
      background: #ffffff;
      border: 1px solid #d7dfeb;
      border-radius: 18px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08);
      padding: 28px 32px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
    }
    p {
      margin: 0;
      color: #61728b;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${escapeHtml(params.title)}</h1>
      <p>${escapeHtml(params.message)}</p>
    </section>
  </main>
</body>
</html>`;
}

function writeErrorHtml(
  response: ServerResponse,
  status: number,
  title: string,
  message: string,
): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(renderHtmlErrorPage({ title, message }));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
