const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const https = require('https');
const os = require('os');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 820,
    minWidth: 620,
    minHeight: 600,
    title: 'Transkrypcja',
    backgroundColor: '#f0efeb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── File picker ───────────────────────────────────────────────────────────────
ipcMain.handle('pick-file', async () => {
  if (mainWindow) { mainWindow.focus(); }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Wybierz plik audio lub wideo',
    filters: [
      { name: 'Audio/Video', extensions: ['mp3','mp4','wav','m4a','ogg','webm','flac','mkv','aac'] },
      { name: 'Wszystkie pliki', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const fp = result.filePaths[0];
  const stat = fs.statSync(fp);
  return { path: fp, name: path.basename(fp), size: stat.size };
});

// ── Save file dialog ──────────────────────────────────────────────────────────
ipcMain.handle('save-file', async (e, { defaultName, ext, content }) => {
  if (mainWindow) { mainWindow.focus(); }
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return result.filePath;
});

ipcMain.handle('save-binary', async (e, { defaultName, ext, data }) => {
  if (mainWindow) { mainWindow.focus(); }
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, Buffer.from(data));
  return result.filePath;
});

// ── FFmpeg helpers ────────────────────────────────────────────────────────────
function findBin(name) {
  const candidates = process.platform === 'win32'
    ? [name + '.exe', 'C:\\ffmpeg\\bin\\' + name + '.exe']
    : ['/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, '/usr/bin/' + name];
  for (const c of candidates) {
    try { require('child_process').execSync(`"${c}" -version 2>&1`); return c; } catch(e) {}
  }
  return null;
}

// ── Transcription ─────────────────────────────────────────────────────────────
ipcMain.handle('transcribe', async (e, { filePath, model, language, apiKey }) => {
  const MAX_BYTES = 24 * 1024 * 1024;
  const fileSize = fs.statSync(filePath).size;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transkrypcja-'));

  try {
    if (fileSize <= MAX_BYTES) {
      mainWindow.webContents.send('progress', { pct: 30, msg: 'Wysyłanie do Groq API...' });
      return await transcribeChunk(filePath, model, language, apiKey, 0);
    }

    const ffmpeg = findBin('ffmpeg');
    const ffprobe = findBin('ffprobe');
    if (!ffmpeg) throw new Error('FFmpeg nie znaleziony.\nZainstaluj: brew install ffmpeg');

    mainWindow.webContents.send('progress', { pct: 10, msg: 'Analizuję plik...' });
    const duration = await getFileDuration(ffprobe || ffmpeg, filePath);
    const chunkSec = 600;
    const numChunks = Math.ceil(duration / chunkSec);

    let allText = '', allSegs = [], totalDur = 0, detectedLang = language;

    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkSec;
      const chunkPath = path.join(tmpDir, `chunk_${i}.mp3`);
      mainWindow.webContents.send('progress', { pct: 15 + Math.floor(i / numChunks * 35), msg: `Konwertowanie ${i+1}/${numChunks}...` });

      await runFFmpeg(ffmpeg, ['-y','-i',filePath,'-ss',String(start),'-t',String(chunkSec),'-ar','16000','-ac','1','-c:a','libmp3lame','-q:a','5',chunkPath]);

      mainWindow.webContents.send('progress', { pct: 50 + Math.floor(i / numChunks * 45), msg: `Transkrybowanie ${i+1}/${numChunks}...` });
      const data = await transcribeChunk(chunkPath, model, language, apiKey, start);

      allText += (allText ? ' ' : '') + data.text.trim();
      if (data.segments) allSegs = allSegs.concat(data.segments);
      if (data.duration) totalDur += data.duration;
      if (data.language) detectedLang = data.language;
    }

    return { text: allText, segments: allSegs, duration: totalDur, language: detectedLang };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function getFileDuration(ffprobe, filePath) {
  return new Promise((resolve, reject) => {
    execFile(ffprobe, ['-v','quiet','-print_format','json','-show_format',filePath], (err, stdout) => {
      if (err) return reject(err);
      try { resolve(parseFloat(JSON.parse(stdout).format.duration)); } catch(e) { reject(e); }
    });
  });
}

function runFFmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, (err) => { if (err) reject(err); else resolve(); });
  });
}

function transcribeChunk(filePath, model, language, apiKey, timeOffset) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(filePath);
    const boundary = '----Boundary' + Date.now();
    const filename = path.basename(filePath);

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}`),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json`),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nsegment`),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}`),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) return reject(new Error(json?.error?.message || `HTTP ${res.statusCode}`));
          if (timeOffset > 0 && json.segments) json.segments.forEach(s => { s.start += timeOffset; s.end += timeOffset; });
          resolve(json);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
