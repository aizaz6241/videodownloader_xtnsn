chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 1. Handle Blob URL Creation (for downloads)
    if (message.action === 'createBlobUrl') {
        try {
            const blob = new Blob(message.chunks, { type: message.mimeType });
            const url = URL.createObjectURL(blob);
            sendResponse({ status: 'success', url: url });
        } catch (error) {
            console.error('Blob creation failed:', error);
            sendResponse({ status: 'error', error: error.toString() });
        }
    }
    // 2. Handle Blob URL Revocation (cleanup)
    else if (message.action === 'revokeBlobUrl') {
        try {
            URL.revokeObjectURL(message.url);
            sendResponse({ status: 'success' });
        } catch (error) {
            console.error('Revoke failed:', error);
        }
    }
    // 3. Handle Image Cropping (thumbnails)
    else if (message.action === 'cropImage') {
        cropImage(message.imageUrl, message.rect).then(croppedUrl => {
            sendResponse({ status: 'success', url: croppedUrl });
        }).catch(err => {
            console.error('Crop failed:', err);
            sendResponse({ status: 'error' });
        });
        return true;
    }
    // 4. Handle IDB Blob URL Creation (large files)
    else if (message.action === 'createUrlFromIDB') {
        (async () => {
            try {
                const blob = await getBlobFromIDB(message.blobKey);
                if (!blob) throw new Error("Blob not found in IDB");
                const url = URL.createObjectURL(blob);
                sendResponse({ status: 'success', url: url, size: blob.size });
            } catch (e) {
                console.error("IDB URL failed:", e);
                sendResponse({ status: 'error', error: e.toString() });
            }
        })();
        return true;
    }
    // 5. Handle Fallback (Raw TS/MP4 concatenation)
    else if (message.action === 'createFallbackUrl') {
        try {
            let chunks = decodeChunks(message);
            const blob = new Blob(chunks, { type: message.mimeType });
            const url = URL.createObjectURL(blob);
            sendResponse({ status: 'success', url: url });
        } catch (e) {
            console.error("Fallback failed:", e);
            sendResponse({ status: 'error', error: e.toString() });
        }
        return true;
    }
    // 6. Handle TRANSMUX (HLS -> MP4) - The Core Logic
    else if (message.action === 'transmux') {
        (async () => {
            try {
                const mux = self.muxjs || self.mux;
                if (!mux) throw new Error("Mux library missing");

                // CONFIGURATION: Force timestamp reset (Fixes 13h issue)
                const transmuxer = new mux.mp4.Transmuxer({ keepOriginalTimeline: false });

                let chunks = decodeChunks(message);
                console.log(`[Transmux] Starting: ${chunks.length} chunks`);

                let initSegment = null;
                const segments = [];

                transmuxer.on('data', (segment) => {
                    // Capture Header (ftyp+moov)
                    if (segment.initSegment) {
                        // CRITICAL: Only capture the FIRST header.
                        // Later headers often contain "live" timestamps causing duration drift.
                        if (!initSegment) {
                            initSegment = segment.initSegment;
                            console.log("[Transmux] First Init Segment Captured");
                        }
                    }
                    // Capture Media (moof+mdat)
                    if (segment.data) {
                        segments.push(segment.data);
                    }
                });

                // Process chunks sequentially
                for (const chunk of chunks) {
                    if (chunk && chunk.byteLength > 0) {
                        try {
                            transmuxer.push(new Uint8Array(chunk));
                        } catch (err) {
                            console.warn("[Transmux] Push warn:", err);
                        }
                    }
                }

                transmuxer.flush();

                console.log(`[Transmux] Complete. Segments: ${segments.length}, Header: ${!!initSegment}`);

                // Assemble final MP4
                const finalData = [];
                if (initSegment) {
                    if (message.duration) {
                        initSegment = patchDuration(initSegment, message.duration);
                    }
                    finalData.push(initSegment);
                }
                finalData.push(...segments);

                const blob = new Blob(finalData, { type: 'video/mp4' });

                if (blob.size === 0) throw new Error("Output blob is 0 bytes");

                // Save to IDB
                const key = `mp4_${Date.now()}`;
                await storeBlobInIDB(key, blob);

                sendResponse({
                    status: 'success',
                    blobKey: key,
                    debug: {
                        in: chunks.length,
                        out: segments.length,
                        size: blob.size
                    }
                });

            } catch (e) {
                console.error("[Transmux] Error:", e);
                sendResponse({ status: 'error', error: e.toString() });
            }
        })();
        return true;
    }

    // Return false for unhandled messages
    return false;
});

// --- Helpers ---

function decodeChunks(message) {
    if (message.base64Chunks) {
        return message.base64Chunks.map(b64 => {
            const bin = atob(b64);
            const len = bin.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
            return bytes.buffer;
        });
    }
    return message.chunks || [];
}

function storeBlobInIDB(key, blob) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('DownloadDB', 2);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        };
        req.onsuccess = (e) => {
            const db = e.target.result;
            const tx = db.transaction('blobs', 'readwrite');
            tx.objectStore('blobs').put(blob, key);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
    });
}

function getBlobFromIDB(key) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('DownloadDB', 2);
        req.onsuccess = (e) => {
            const tx = e.target.result.transaction('blobs', 'readonly');
            const getReq = tx.objectStore('blobs').get(key);
            getReq.onsuccess = () => resolve(getReq.result);
            getReq.onerror = () => reject(getReq.error);
        };
        req.onerror = () => reject(req.error);
    });
}

function cropImage(url, rect) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const cvs = document.createElement('canvas');
            const w = 320;
            const scale = w / rect.width;
            cvs.width = w;
            cvs.height = rect.height * scale;
            cvs.getContext('2d').drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, w, cvs.height);
            resolve(cvs.toDataURL('image/jpeg', 0.6));
        };
        img.onerror = reject;
        img.src = url;
    });
}

function patchDuration(initSegment, durationSec) {
    try {
        const data = new Uint8Array(initSegment);
        let mvhdIndex = -1;
        for (let i = 0; i < data.length - 4; i++) {
            if (data[i] === 0x6D && data[i + 1] === 0x76 && data[i + 2] === 0x68 && data[i + 3] === 0x64) {
                mvhdIndex = i;
                break;
            }
        }
        if (mvhdIndex === -1) return initSegment;

        const versionOffset = mvhdIndex + 4;
        const version = data[versionOffset];

        let timescaleOffset, durationOffset;
        if (version === 1) {
            timescaleOffset = versionOffset + 4 + 8 + 8;
            durationOffset = timescaleOffset + 4;
        } else {
            timescaleOffset = versionOffset + 4 + 4 + 4;
            durationOffset = timescaleOffset + 4;
        }

        const ts = (data[timescaleOffset] << 24) | (data[timescaleOffset + 1] << 16) | (data[timescaleOffset + 2] << 8) | data[timescaleOffset + 3];
        const timescale = ts >>> 0;

        if (timescale === 0) return initSegment;

        const newDuration = Math.round(durationSec * timescale);

        if (version === 1) {
            const high = Math.floor(newDuration / 4294967296);
            const low = newDuration % 4294967296;
            data[durationOffset] = (high >> 24) & 0xFF;
            data[durationOffset + 1] = (high >> 16) & 0xFF;
            data[durationOffset + 2] = (high >> 8) & 0xFF;
            data[durationOffset + 3] = high & 0xFF;
            data[durationOffset + 4] = (low >> 24) & 0xFF;
            data[durationOffset + 5] = (low >> 16) & 0xFF;
            data[durationOffset + 6] = (low >> 8) & 0xFF;
            data[durationOffset + 7] = low & 0xFF;
        } else {
            data[durationOffset] = (newDuration >>> 24) & 0xFF;
            data[durationOffset + 1] = (newDuration >>> 16) & 0xFF;
            data[durationOffset + 2] = (newDuration >>> 8) & 0xFF;
            data[durationOffset + 3] = newDuration & 0xFF;
        }
        console.log(`[Patch] Updated MP4 Duration to ${newDuration} (Timescale ${timescale})`);
        return data.buffer;
    } catch (e) {
        console.warn("Patch failed", e);
        return initSegment;
    }
}
