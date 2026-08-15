const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const analyze = require('./api/analyze');

const root = __dirname;
const MAX_REQUEST_BYTES = 25_000;

// Load local secrets without overriding values explicitly supplied by the environment.
for (const fileName of ['.env.local', '.env']) {
    const filePath = path.join(root, fileName);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
}

function sendResponse(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(payload));
}

function adaptVercelResponse(res) {
    res.status = (status) => {
        res.statusCode = status;
        return res;
    };
    res.json = (payload) => {
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
        return res;
    };
    return res;
}

function handleAnalyze(req, res) {
    let bytes = 0;
    const chunks = [];
    let rejected = false;

    req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) {
            rejected = true;
            return;
        }
        chunks.push(chunk);
    });
    req.on('error', () => {
        if (!res.writableEnded) sendResponse(res, 400, { error: 'Could not read request body.' });
    });
    req.on('end', async () => {
        if (rejected) return sendResponse(res, 413, { error: 'Request body is too large.' });
        req.body = Buffer.concat(chunks).toString('utf8');
        await analyze(req, adaptVercelResponse(res));
    });
}

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8'
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/api/analyze') return handleAnalyze(req, res);
    if (url.pathname === '/api/analyze') return sendResponse(res, 405, { error: 'Method not allowed.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendResponse(res, 405, { error: 'Method not allowed.' });

    const target = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\])+/, '');
    const file = path.join(root, target);
    if (target.startsWith('.') || !file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return sendResponse(res, 404, { error: 'Not found.' });
    }

    res.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Opportunity Copilot AI is running on http://localhost:${PORT}`));
