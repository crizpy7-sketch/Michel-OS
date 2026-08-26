/**
 * Static file serving for `public/` (Agent B3).
 *
 * There is no CDN and no bundler in this stack, so the server itself hands out
 * the stylesheet, the scripts and the icons. That makes path traversal this
 * file's whole security concern, and it is handled by construction rather than
 * by pattern-matching for `..`:
 *
 *   1. the URL path is decoded and normalised into a resolved absolute path;
 *   2. that path is required to be inside the root, checked with a separator
 *      suffix so `/srv/public-evil` cannot pass as inside `/srv/public`.
 *
 * Blocklisting `..` would be the obvious approach and it is the wrong one:
 * `%2e%2e`, `..%2f`, `....//` and UTF-8 overlong forms all mean `..` by the
 * time the filesystem sees them. Resolving first and then asking "is this
 * inside?" is immune to how the traversal was spelled.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, resolve, sep, extname } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * Content types, by extension.
 *
 * An unknown extension is served as `application/octet-stream` rather than
 * guessed: combined with `x-content-type-options: nosniff`, an uploaded file
 * with a surprising extension downloads instead of executing.
 */
const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
});

export interface ResolvedAsset {
  path: string;
  size: number;
  contentType: string;
  /** Weak validator built from size and mtime — enough to skip a re-download. */
  etag: string;
}

/**
 * Resolve a URL path to a file inside `root`, or `null`.
 *
 * Exported separately from the serving so the traversal defence can be tested
 * without a socket: the interesting cases are all about which paths resolve,
 * and a test that has to spin up a server to ask that question is a test nobody
 * writes enough of.
 */
export async function resolveAsset(root: string, urlPath: string): Promise<ResolvedAsset | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // A malformed escape is not a path. Refusing beats guessing at the intent.
    return null;
  }

  // A NUL byte truncates the path in some syscalls, so `/style.css\0.png` could
  // pass an extension check and open something else entirely.
  if (decoded.includes('\0')) return null;

  const rootAbs = resolve(root);
  const candidate = resolve(join(rootAbs, normalize(decoded)));

  // The separator suffix is the point: `startsWith(rootAbs)` alone would accept
  // a sibling directory whose name merely begins with the root's.
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + sep)) return null;

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(candidate);
  } catch {
    return null;
  }
  // Directories are not served, and neither is anything that is not a plain
  // file: a device node or a socket under `public/` is not a page.
  if (!info.isFile()) return null;

  return {
    path: candidate,
    size: info.size,
    contentType: TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
    etag: `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
  };
}

/**
 * How long a browser may cache this asset.
 *
 * Everything under `/assets/` is expected to carry a content hash in its name,
 * so it can be cached hard. Everything else — the manifest, the icons, an
 * unhashed script — gets a short window plus revalidation, which is the honest
 * answer when the URL does not change with the content.
 */
export function cacheControlFor(urlPath: string): string {
  return urlPath.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=300, must-revalidate';
}

/**
 * Stream an asset to the response.
 *
 * Streams rather than reads: an icon set is small, but reading a file fully
 * into memory to write it out again scales with concurrent requests rather than
 * with file size, and there is no reason to pay that.
 */
export function sendAsset(
  res: ServerResponse,
  asset: ResolvedAsset,
  options: { baseHeaders: Record<string, string>; cacheControl: string; ifNoneMatch?: string | undefined },
): void {
  const headers: Record<string, string> = {
    ...options.baseHeaders,
    'content-type': asset.contentType,
    'cache-control': options.cacheControl,
    etag: asset.etag,
  };

  if (options.ifNoneMatch === asset.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['content-length'] = String(asset.size);
  res.writeHead(200, headers);

  if (res.req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(asset.path);
  stream.on('error', () => {
    // The head is already on the wire, so there is no status left to send.
    // Destroying the socket is what tells the client the body is incomplete;
    // ending normally would hand over a truncated file that looks complete.
    res.destroy();
  });
  stream.pipe(res);
}
