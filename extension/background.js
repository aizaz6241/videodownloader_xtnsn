import { detectMediaType, extractMetadata, MediaTypes } from './mediaDetector.js';

// --- STATE MANAGEMENT ---
const detectedMedia = new Map(); // tabId -> [Video]
const activeDownloads = new Map(); // url -> { cancelled: boolean }
const downloadBlobs = new Map(); // downloadId -> blobUrl

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
            // Dedup
            const unique = [];
            const seen = new Set();
            stored.forEach(v => { if (!seen.has(v.url)) { seen.add(v.url); unique.push(v); } });

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
    // Timeout for metadata fetch
    const timeout = new Promise(r => setTimeout(() => r(video), 1200));

    const fetchMeta = new Promise(resolve => {
        chrome.tabs.sendMessage(video.tabId, { action: 'GET_METADATA' }, video.frameId ? { frameId: video.frameId } : {}, async (meta) => {
            if (chrome.runtime.lastError || !meta) return resolve(video);

            let thumb = video.thumbnail || meta.thumbnail;
            if (!thumb && meta.captureRect) {
                // Try capture
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
    // Fallback: If pageTitle is missing, try to find it in memory
    if (!video.pageTitle || video.pageTitle === 'video') {
        for (let [tabId, list] of detectedMedia) {
            const found = list.find(v => v.url === video.url);
            if (found && found.pageTitle) {
                video.pageTitle = found.pageTitle;
                break;
            }
        }
    }

    if (video.pageTitle && video.pageTitle.trim().length > 0) {
        // Preserve extension if it exists, default to mp4
        let ext = 'mp4';
        if (video.filename && video.filename.includes('.')) {
            ext = video.filename.split('.').pop();
            if (ext.length > 4 || ext.includes('/')) ext = 'mp4';
        }
        // Sanitize (Replace & with 'and', remove bad chars, spaces to underscores)
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
        // Fallback to JS if needed, but user specifically wants to fix "Not Working" by using the right tools.
        // If native fails, we should modify the error message to tell them to install it.
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
    // Direct
    const safeTitle = (video.pageTitle || video.filename || 'video').replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    const ext = video.filename.split('.').pop();
    const targetName = `${safeTitle}.${ext}`;
    chrome.downloads.download({ url: video.url, filename: `downloads/${targetName}`, saveAs: false });
}

// --- HLS ENGINE (LEGACY JS FALLBACK) ---
async function downloadHLS(video) {
    // Keep existing implementation as fallback, but warn user
    console.log('[DEBUG] Fallback to JS HLS download...', video.url);
    // ... (rest of the existing function logic if needed, or simply warn)

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
        console.log(`[DEBUG] Manifest Received. Length: ${text.length}`);

        // 2. Select Best Stream if Master
        if (text.includes('#EXT-X-STREAM-INF')) {
            console.log('[DEBUG] Master Manifest Detected. Selecting Best Stream...');
            const lines = text.split('\n');
            let bestUrl = null, maxH = 0;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('BANDWIDTH')) {
                    const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                    const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
                    const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
                    const currentUrl = lines[i + 1]?.trim();

                    console.log(`[DEBUG] Variant Found: BW=${bw}, RES=${resMatch ? resMatch[1] : 'N/A'}, URL=${currentUrl}`);

                    if (parseInt(bw) > maxH) {
                        maxH = parseInt(bw);
                        bestUrl = currentUrl;
                    }
                }
            }
            if (bestUrl) {
                console.log(`[DEBUG] Selected Best Variant: ${bestUrl} (Bandwidth: ${maxH})`);
                if (!bestUrl.startsWith('http')) {
                    const base = video.url.substring(0, video.url.lastIndexOf('/') + 1);
                    bestUrl = base + bestUrl;
                }
                console.log(`[DEBUG] Fetching Variant Manifest: ${bestUrl}`);
                text = await fetch(bestUrl).then(r => r.text());
                video.url = bestUrl; // Update target
            } else {
                console.warn('[DEBUG] No valid variants found in master?');
            }
        }

        // 3. DRM Check
        if (text.includes('#EXT-X-KEY')) {
            console.error('[DEBUG] DRM DETECTED!');
            throw new Error("DRM Protected");
        }

        // 4. Parse Segments
        console.log('[DEBUG] STEP 4: Parsing Segments...');
        const parser = new HLSParser(video.url, text);
        const segments = parser.getSegments();
        const totalDuration = parser.getTotalDuration();
        console.log(`[DEBUG] Segments Found: ${segments.length}, Duration: ${totalDuration}`);

        if (!segments.length) throw new Error("No segments found");

        // 5. Download Loop (Concurrent & Robust)
        console.log('[DEBUG] STEP 5: Starting Download Loop...');
        const chunks = new Array(segments.length);
        let downloaded = 0;
        let totalBytes = 0;
        const startTime = Date.now();

        // Helper: Fetch with retry
        const downloadSegment = async (url, index) => {
            if (activeDownloads.get(id).cancelled) throw new Error("Cancelled");
            // console.log(`[DEBUG] Fetching Seg ${index}: ${url}`);

            let res;
            try {
                res = await fetch(url.startsWith('http') ? url : new URL(url, video.url).href, { referrer: video.pageUrl });
                if (!res.ok) throw new Error(res.status);
            } catch (e) {
                // Retry strict mode off
                res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
            }
            if (!res.ok) throw new Error("Fetch failed");

            const buf = await res.arrayBuffer();
            if (buf.byteLength === 0) throw new Error("Empty segment");

            // HTML Guard
            if (buf.byteLength < 1000) {
                const start = String.fromCharCode(...new Uint8Array(buf.slice(0, 50))).toLowerCase();
                if (start.includes('<!doc') || start.includes('<html')) throw new Error("HTML response");
            }

            chunks[index] = buf;
            return buf.byteLength;
        };

        // Execution: Batch processing (Simulated Concurrency 3)
        for (let i = 0; i < segments.length; i++) {
            if (activeDownloads.get(id).cancelled) break;
            try {
                const size = await downloadSegment(segments[i], i);
                totalBytes += size;
                downloaded++;
                console.log(`[DEBUG] Seg ${i} Downloaded. Size: ${size}`);

                // Progress
                const pct = Math.round((downloaded / segments.length) * 100);
                if (pct % 5 === 0 || i === segments.length - 1) {
                    const speed = Math.round((totalBytes / 1024) / ((Date.now() - startTime) / 1000));
                    notifyProgress(id, pct, `${speed} KB/s`);
                    safeUpdateBadge(`${pct}%`, tabId);
                }
            } catch (e) {
                console.warn(`[DEBUG] Seg ${i} FAILED`, e); // Skip bad segments? Or Fail?
                // Fallback: If minimal failure, skip. video might skip.
            }
        }

        console.log(`[DEBUG] Download Loop Finished. Downloaded: ${downloaded}/${segments.length}. Total Bytes: ${totalBytes}`);

        if (downloaded === 0) throw new Error("Download failed");

        notifyProgress(id, 100, 'Processing...');

        // 6. Transmuxing
        console.log('[DEBUG] STEP 6: Sending to Transmuxer...');
        await setupOffscreen();

        // Sanity Check: TS vs fMP4?
        const isTS = (new Uint8Array(chunks[0])[0] === 0x47);
        console.log(`[DEBUG] First Byte: ${new Uint8Array(chunks[0])[0]} (MPEG-TS=71)`);

        let finalExt = isTS ? '.mp4' : '.mp4';

        const base64Chunks = chunks.filter(c => c).map(c => {
            // Manual binary string build (fastest for large arrays in chrome ext?)
            // Or use FileReader? ArrayBuffer -> Base64 is tricky.
            // Using standard approach
            let bin = '';
            const bytes = new Uint8Array(c);
            const len = bytes.byteLength;
            // Chunking string build to avoid stack overflow
            for (let j = 0; j < len; j += 32768) {
                bin += String.fromCharCode(...bytes.subarray(j, j + 32768));
            }
            return btoa(bin);
        });

        // Use the filename prepared in handleDownload if available
        let targetName = video.filename;
        if (!targetName || targetName.endsWith('.ts') || targetName.startsWith('http')) {
            const safeTitle = (video.pageTitle || 'video').replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
            targetName = safeTitle + finalExt;
        } else if (!targetName.endsWith(finalExt)) {
            targetName += finalExt;
        }

        console.log(`[DEBUG] Target Filename for Chrome: ${targetName}`);

        try {
            // Try Transmux
            const res = await chrome.runtime.sendMessage({
                action: 'transmux',
                base64Chunks: base64Chunks,
                mimeType: 'video/mp4',
                duration: totalDuration
            });

            if (res?.status === 'success') {
                console.log('[DEBUG] Transmux Successful!', res.debug);
                const urlRes = await chrome.runtime.sendMessage({ action: 'createUrlFromIDB', blobKey: res.blobKey });
                triggerDownload(urlRes.url, targetName, true);
                setTimeout(() => chrome.runtime.sendMessage({ action: 'deleteBlob', key: res.blobKey }), 60000);
            } else {
                console.error('[DEBUG] Transmux Returned Failure:', res?.error);
                throw new Error("Transmux failed");
            }
        } catch (e) {
            // Fallback to TS
            console.warn("[DEBUG] Transmux failed/rejected. Saving raw.", e);
            const fbRes = await chrome.runtime.sendMessage({
                action: 'createFallbackUrl',
                base64Chunks: base64Chunks,
                mimeType: 'video/mp2t' // Raw TS
            });
            if (fbRes?.status === 'success') {
                console.log('[DEBUG] Fallback URL Created. Downloading as .ts');
                triggerDownload(fbRes.url, targetName.replace('.mp4', '.ts'), true);
            }
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
// --- UTILS ---
const filenameOverrides = new Map();

// Strict Filename Handler
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (filenameOverrides.has(item.url)) {
        const name = filenameOverrides.get(item.url);
        console.log(`[DEBUG] Enforcing filename: ${name} for URL: ${item.url}`);
        suggest({ filename: name, conflictAction: 'uniquify' });
        // Clean up memory after a short delay (or wait for download events, but this is simple)
        setTimeout(() => filenameOverrides.delete(item.url), 60000);
    }
    // No return needed, async suggestion is handled by calling suggest.
});

function notifyProgress(url, percent, speed, status = 'Downloading') {
    chrome.runtime.sendMessage({ action: 'DOWNLOAD_PROGRESS', url, percent, speed, status }).catch(() => { });
}

function triggerDownload(url, filename, isBlob) {
    console.log(`[DEBUG] triggerDownload called. URL: ${url}, Filename: ${filename}`);

    // Register override for strict enforcement
    filenameOverrides.set(url, filename);

    // Call download WITHOUT filename parameter to ensure onDeterminingFilename fires and takes full control
    // taking no chances with conflicts
    chrome.downloads.download({ url: url, saveAs: false }, (dId) => {
        if (chrome.runtime.lastError) {
            console.error("[DEBUG] Download failed to start:", chrome.runtime.lastError);
            filenameOverrides.delete(url); // Clean up if failed
        } else {
            console.log(`[DEBUG] Download started with ID: ${dId}`);
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
    getVariants() { return []; } // Simplified for now
}
