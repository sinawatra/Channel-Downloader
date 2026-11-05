import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import { startJob } from './job.js';
import { parseChannelUrl } from './platforms/index.js';

const INDEX = new URL('../public/index.html', import.meta.url);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('Request too large');
  }
  return JSON.parse(raw || '{}');
}

export function createAppServer({ outputRoot, profileDir, browserChannel, openFolder }) {
  let job = null;

  return http.createServer(async (req, res) => {
    // This server starts a browser and writes files, so only this page may call it.
    const port = req.socket.localPort;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const origin = req.headers.origin;
    if (!allowed.has(req.headers.host) || (origin && !allowed.has(origin.replace(/^https?:\/\//, '')))) {
      return sendJson(res, 403, { error: 'Forbidden' });
    }

    const route = `${req.method} ${req.url.split('?')[0]}`;
    try {
      if (route === 'GET /') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(await readFile(INDEX));
      }
      if (route === 'GET /api/state') {
        return sendJson(res, 200, { root: outputRoot, job: job?.snapshot() ?? null });
      }
      if (route === 'POST /api/start') {
        if (job?.running) return sendJson(res, 409, { error: 'A download is already running.' });
        const { url, limit } = await readJson(req);
        const channel = parseChannelUrl(url);
        const max = Number(limit);
        job = startJob({
          channel,
          limit: max > 0 ? Math.floor(max) : 0,
          root: outputRoot,
          profileDir,
          browserChannel,
        });
        return sendJson(res, 200, { ok: true });
      }
      if (route === 'POST /api/stop') {
        job?.stop();
        return sendJson(res, 200, { ok: true });
      }
      if (route === 'POST /api/open-folder') {
        await mkdir(outputRoot, { recursive: true });
        await openFolder(job?.directory ?? outputRoot);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  });
}
