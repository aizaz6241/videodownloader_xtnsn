import { detectMediaType, extractMetadata, MediaTypes } from './mediaDetector.js';

// --- STATE MANAGEMENT ---
const detectedMedia = new Map(); // tabId -> [Video]
const activeDownloads = new Map(); // url -> { cancelled: boolean }
const downloadBlobs = new Map(); // downloadId -> blobUrl
const filenameOverrides = new Map(); // Strict Filename Map

// --- BADGE ---
function updateBadge(tabId) {
    const videos = detectedMedia.get(tabId) || [];
    const count = videos.length;
    chrome.action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId: tabId || null });
    if (count > 0) chrome.action.setBadgeBackgroundColor({ color: '#F00', tabId: tabId || null });
}

function safeUpdateBadge(text, tabId) {
    if (tabId && tabId >= 0) {
        chrome.action.setBadgeText({ text, tabId }).catch(() => { });
        if (text === 'ERR' || text === 'OK' || text.includes('%')) {
            chrome.action.setBadgeBackgroundColor({ color: '#228be6', tabId }).catch(() => { });
        }
    }
}

// --- 1. NETWORK SNIFFER ---
chrome.webRequest.onHeadersReceived.addListener((details) => {
    if (details.tabId === -1) return;
    const type = detectMediaType(details);
    if (type) {
        const metadata = extractMetadata(details, type);
        if (!detectedMedia.has(details.tabId)) detectedMedia.set(details.tabId, []);
        const list = detectedMedia.get(details.tabId);

        // Dedup by URL
        if (!list.find(v => v.url === details.url)) {
            chrome.tabs.get(details.tabId, (tab) => {
                if (chrome.runtime.lastError) return;
                const pageTitle = (tab.title || 'video').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 50);

                // Smart Naming
                if (type === 'hls' || type === 'dash') {
                    const count = list.filter(v => v.filename.startsWith(pageTitle)).length;
                    metadata.filename = `${pageTitle}${count > 0 ? '_' + (count + 1) : ''}.ts`;
                } else if (metadata.filename.match(/^master|^manifest/)) {
                    metadata.filename = `${pageTitle}.ts`;
                }

                metadata.pageTitle = tab.title;
                metadata.pageUrl = tab.url; // Referer
                metadata.tabId = details.tabId;
                list.push(metadata);
                updateBadge(details.tabId);
            });
        }
    }
}, { urls: ["<all_urls>"] }, ["responseHeaders"]);

// --- 2. MESSAGE BUS ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // A. Popup requests videos
    if (msg.action === 'GET_VIDEOS') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (!tab) return sendResponse({ videos: [] });

            let stored = detectedMedia.get(tab.id) || [];
            
            // DEDUPLICATION LOGIC
            const unique = [];
            const seenUrls = new Set();
            const seenTitles = new Set();
            
            stored.forEach(v => { 
                if (seenUrls.has(v.url)) return;
                seenUrls.add(v.url);

                // Title dedup: If we already have a video with this title, assume duplicates/variants
                if (v.pageTitle && v.pageTitle !== 'video') {
                     if (seenTitles.has(v.pageTitle)) return;
                     seenTitles.add(v.pageTitle);
                }
                unique.push(v); 
            });

            // Enrich with Duration/Thumb
            Promise.all(unique.map(enrichVideo)).then(final => sendResponse({ videos: final }));
        });
        return true;
    }

    // B. Cancel/Download Control
    if (msg.action === 'CANCEL_DOWNLOAD') {
        if (activeDownloads.has(msg.url)) {
            activeDownloads.get(msg.url).cancelled = true;
            sendResponse({ status: 'cancelled' });
        } else sendResponse({ status: 'not_found' });
        return true;
    }

    // C. Get Variants
    if (msg.action === 'GET_VARIANTS') {
        handleGetVariants(msg).then(sendResponse);
        return true;
    }

    // D. Start Download
    if (msg.action === 'DOWNLOAD_MEDIA') {
        const video = msg.video;
        sendResponse({ status: 'started' });
        if (video) handleDownload(video).catch(err => {
            console.error("DL Error:", err);
            chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title: 'Failed', message: err.message });
        });
        return false;
    }
});

// --- ENRICHMENT LOGIC ---
async function enrichVideo(video) {
    if (!video.tabId) return video;
    const timeout = new Promise(r => setTimeout(() => r(video), 1200));

    const fetchMeta = new Promise(resolve => {
        chrome.tabs.sendMessage(video.tabId, { action: 'GET_METADATA' }, video.frameId ? { frameId: video.frameId } : {}, async (meta) => {
            if (chrome.runtime.lastError || !meta) return resolve(video);

            let thumb = video.thumbnail || meta.thumbnail;
            if (!thumb && meta.captureRect) {
                try {
                    const ss = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 50 });
                    await setupOffscreen();
                    const crop = await chrome.runtime.sendMessage({ action: 'cropImage', imageUrl: ss, rect: meta.captureRect });
                    if (crop?.status === 'success') thumb = crop.url;
                } catch (e) { }
            }
            resolve({ ...video, duration: meta.duration || video.duration, thumbnail: thumb, pageTitle: video.pageTitle || meta.pageTitle });
        });
    });
    return Promise.race([fetchMeta, timeout]);
}

// --- VARIANT LOGIC ---
async function handleGetVariants(msg) {
    try {
        const text = await fetch(msg.url).then(r => r.text());
        const parser = new HLSParser(msg.url, text);
        return { variants: parser.getVariants() };
    } catch (e) {
        return { variants: [] };
    }
}

// --- 3. NATIVE MESSAGING ---
const HOST_NAME = "com.streamsniffer.pro";

function sendToNative(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError);
            }
            resolve(response);
        });
    });
}

// --- DOWNLOAD HANDLER ---
async function handleDownload(video) {
    // 0. Force Metadata correction (Fix filename issue)
    if (!video.pageTitle || video.pageTitle === 'video') {
        // Fallback search
        for (let [tabId, list] of detectedMedia) {
             const found = list.find(v => v.url === video.url);
             if (found && found.pageTitle) {
                 video.pageTitle = found.pageTitle;
                 break;
             }
        }
    }

    if (video.pageTitle && video.pageTitle.trim().length > 0) {
         let ext = 'mp4';
         if (video.filename && video.filename.includes('.')) {
             ext = video.filename.split('.').pop();
             if (ext.length > 4 || ext.includes('/')) ext = 'mp4';
         }
         
         // Strict Sanitization
         let safe = video.pageTitle.replace(/&/g, 'and');
         safe = safe.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, '_').trim();
         
         video.filename = `${safe}.${ext}`;
         console.log(`[DEBUG] Final Filename set to: ${video.filename}`);
    } else {
        console.warn('[DEBUG] No pageTitle available for filename generation.');
    }

    // Try Native First
    try {
        console.log('[DEBUG] Attempting Native Download...');
        await sendToNative({
            action: 'DOWNLOAD',
            url: video.url,
            filename: video.filename,
            headers: {
                "Referer": video.pageUrl,
                "User-Agent": navigator.userAgent
            }
        });
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'Download Started',
            message: 'Video sent to Companion App'
        });
        return;
    } catch (e) {
        console.warn('[DEBUG] Native Host failed/missing:', e);
        if (e.message && e.message.includes("NativeMessagingHosts")) {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon48.png',
                title: 'Companion App Needed',
                message: 'Please run register_host.bat in the companion-app folder.'
            });
            return;
        }
    }

    if (video.type === MediaTypes.HLS) return downloadHLS(video);
    
    // Direct Download
    const safeTitle = (video.pageTitle || video.filename || 'video').replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    const ext = video.filename.split('.').pop();
    const targetName = `${safeTitle}.${ext}`;
    triggerDownload(video.url, targetName, false);
}

// --- HLS ENGINE (LEGACY JS FALLBACK) ---
async function downloadHLS(video) {
    console.log('[DEBUG] Fallback to JS HLS download...', video.url);
    const session = Math.random().toString(36).substring(7);

    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Using Legacy Mode',
        message: 'Native app not found. Using slower browser download.'
    });

    const id = video.url;
    activeDownloads.set(id, { cancelled: false });
    const tabId = video.tabId;
    safeUpdateBadge('...', tabId);

    try {
        notifyProgress(id, 0, 'Starting...');

        // 1. Get Manifest
        console.log('[DEBUG] STEP 1: Fetching Manifest...');
        let response = await fetch(video.url);
        let text = await response.text();

        // 2. Select Best Stream if Master
        if (text.includes('#EXT-X-STREAM-INF')) {
            console.log('[DEBUG] Master Manifest Detected. Selecting Best Stream...');
            const lines = text.split('\n');
            let bestUrl = null, maxH = 0;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('BANDWIDTH')) {
                    const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                    const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
                    const currentUrl = lines[i + 1]?.trim();
                    if (parseInt(bw) > maxH) {
                        maxH = parseInt(bw);
                        bestUrl = currentUrl;
                    }
                }
            }
            if (bestUrl) {
                if (!bestUrl.startsWith('http')) {
                    const base = video.url.substring(0, video.url.lastIndexOf('/') + 1);
                    bestUrl = base + bestUrl;
                }
                console.log(`[DEBUG] Fetching Variant Manifest: ${bestUrl}`);
                text = await fetch(bestUrl).then(r => r.text());
                video.url = bestUrl;
            }
        }

        // 3. DRM Check
        if (text.includes('#EXT-X-KEY')) {
            throw new Error("DRM Protected");
        }

        // 4. Parse Segments
        console.log('[DEBUG] STEP 4: Parsing Segments...');
        const parser = new HLSParser(video.url, text);
        const segments = parser.getSegments();
        const totalDuration = parser.getTotalDuration();
        
        if (!segments.length) throw new Error("No segments found");

        // 5. Download Loop
        console.log('[DEBUG] STEP 5: Starting Download Loop...');
        const chunks = new Array(segments.length);
        let downloaded = 0;
        let totalBytes = 0;
        const startTime = Date.now();

        const downloadSegment = async (url, index) => {
            if (activeDownloads.get(id).cancelled) throw new Error("Cancelled");
            let res;
            try {
                res = await fetch(url.startsWith('http') ? url : new URL(url, video.url).href, { referrer: video.pageUrl });
                if (!res.ok) throw new Error(res.status);
            } catch (e) {
                res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
            }
            if (!res.ok) throw new Error("Fetch failed");
            const buf = await res.arrayBuffer();
            if (buf.byteLength === 0) throw new Error("Empty segment");
            if (buf.byteLength < 1000) {
                 const start = String.fromCharCode(...new Uint8Array(buf.slice(0, 50))).toLowerCase();
                 if (start.includes('<!doc') || start.includes('<html')) throw new Error("HTML response");
            }
            chunks[index] = buf;
            return buf.byteLength;
        };

        // Execution
        for (let i = 0; i < segments.length; i++) {
            if (activeDownloads.get(id).cancelled) break;
            try {
                const size = await downloadSegment(segments[i], i);
                totalBytes += size;
                downloaded++;
                const pct = Math.round((downloaded / segments.length) * 100);
                if (pct % 5 === 0 || i === segments.length - 1) {
                    const speed = Math.round((totalBytes / 1024) / ((Date.now() - startTime) / 1000));
                    notifyProgress(id, pct, `${speed} KB/s`);
                    safeUpdateBadge(`${pct}%`, tabId);
                }
            } catch (e) {
                console.warn(`[DEBUG] Seg ${i} FAILED`, e);
            }
        }

        if (downloaded === 0) throw new Error("Download failed");
        notifyProgress(id, 100, 'Processing...');

        // 6. Transmuxing using IDB to bypass 64MB limit
        console.log('[DEBUG] STEP 6: Sending to Transmuxer...');
        
        const chunkKeys = [];
        await setupOffscreen();
        
        const saveChunk = (chunk, idx) => {
             return new Promise((resolve, reject) => {
                 const key = `chunk_${session}_${Date.now()}_${idx}`;
                 const req = indexedDB.open('DownloadDB', 2);
                 req.onupgradeneeded = (e) => {
                      const db = e.target.result;
                      if (!db.objectStoreNames.contains('blobs')) {
                           db.createObjectStore('blobs');
                      }
                 };
                 req.onsuccess = (e) => {
                     const tx = e.target.result.transaction('blobs', 'readwrite');
                     tx.objectStore('blobs').put(new Blob([chunk]), key);
                     tx.oncomplete = () => {  e.target.result.close(); resolve(key); };
                     tx.onerror = () => reject(tx.error);
                 };
                 req.onerror = () => reject(req.error);
             });
        };

        for (let i = 0; i < chunks.length; i++) {
             if (chunks[i]) chunkKeys.push(await saveChunk(chunks[i], i));
        }

        // Filename
        let finalExt = '.mp4';
        let targetName = video.filename;
        if (!targetName || targetName.endsWith('.ts') || targetName.startsWith('http')) {
             const safeTitle = (video.pageTitle || 'video').replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
             targetName = safeTitle + finalExt;
        } else if (!targetName.endsWith(finalExt)) {
             targetName += finalExt;
        }

        try {
            const res = await chrome.runtime.sendMessage({
                action: 'transmux',
                chunkKeys: chunkKeys, // Keys only!
                mimeType: 'video/mp4',
                duration: totalDuration
            });

            if (res?.status === 'success') {
                console.log('[DEBUG] Transmux Successful!');
                const urlRes = await chrome.runtime.sendMessage({ action: 'createUrlFromIDB', blobKey: res.blobKey });
                triggerDownload(urlRes.url, targetName, true);
                setTimeout(() => chrome.runtime.sendMessage({ action: 'deleteBlob', key: res.blobKey }), 60000);
            } else {
                throw new Error("Transmux failed");
            }
        } catch (e) {
            console.error(e);
            throw e; 
        }

    } catch (err) {
        console.error("[DEBUG] HLS PROCESS FAILED:", err);
        safeUpdateBadge('ERR', tabId);
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title: 'Error', message: err.message });
        notifyProgress(id, 0, 'Error', 'Error');
    } finally {
        activeDownloads.delete(id);
    }
}

// Strictly monitor filenames
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (filenameOverrides.has(item.url)) {
        const name = filenameOverrides.get(item.url);
        suggest({ filename: name, conflictAction: 'uniquify' });
        setTimeout(() => filenameOverrides.delete(item.url), 60000);
    }
});

function notifyProgress(url, percent, speed, status = 'Downloading') {
    chrome.runtime.sendMessage({ action: 'DOWNLOAD_PROGRESS', url, percent, speed, status }).catch(() => { });
}

function triggerDownload(url, filename, isBlob) {
    console.log(`[DEBUG] triggerDownload called. URL: ${url}, Filename: ${filename}`);
    filenameOverrides.set(url, filename);
    chrome.downloads.download({ url: url, saveAs: false }, (dId) => {
        if (chrome.runtime.lastError) {
             console.error("[DEBUG] Download failed to start:", chrome.runtime.lastError);
             filenameOverrides.delete(url);
        } else {
             if (isBlob && dId) {
                downloadBlobs.set(dId, url);
                setTimeout(() => {
                    URL.revokeObjectURL(url);
                    chrome.runtime.sendMessage({ action: 'revokeBlobUrl', url });
                }, 900000);
            }
        }
    });
}

let creatingOffscreen;
async function setupOffscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Blob' });
}

class HLSParser {
    constructor(base, text) { this.base = base; this.text = text; }
    getSegments() {
        return this.text.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).map(l => new URL(l.trim(), this.base).href);
    }
    getTotalDuration() {
        let total = 0;
        const lines = this.text.split('\n');
        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) {
                const part = line.substring(8).split(',')[0];
                const d = parseFloat(part);
                if (!isNaN(d)) total += d;
            }
        }
        return total > 0 ? total : 0;
    }
    getVariants() { return []; } 
}
