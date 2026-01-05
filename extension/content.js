console.log("StreamSniffer Pro: Content script active");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Universal metadata getter
    if (message.action === 'GET_METADATA' || message.action === 'GET_DURATION') {
        const videos = Array.from(document.getElementsByTagName('video'));
        let bestVideo = null;
        let maxArea = 0;

        // Find the "main" video (largest visible area preferred)
        for (let v of videos) {
            const rect = v.getBoundingClientRect();
            // Check visibility
            const isVisible = rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
            const area = rect.width * rect.height;
            if (isVisible && area > maxArea && v.currentSrc) {
                maxArea = area;
                bestVideo = v;
            }
        }

        // Fallback: Longest duration
        if (!bestVideo) {
            let maxDuration = 0;
            for (let v of videos) {
                if (v.duration && !isNaN(v.duration) && v.duration > maxDuration) {
                    maxDuration = v.duration;
                    bestVideo = v;
                }
            }
        }

        if (bestVideo) {
            // 1. Try Poster FIRST
            let poster = bestVideo.poster;
            if (poster) {
                if (!poster.startsWith('http') && !poster.startsWith('data:')) {
                    poster = new URL(poster, window.location.href).href;
                }
                const lower = poster.toLowerCase();
                if (lower.includes('blank.gif') ||
                    lower.includes('transparent') ||
                    lower.includes('1x1') ||
                    lower.includes('empty')) {
                    poster = null;
                }
            }

            // 2. Try Canvas Snapshot
            let thumbnail = poster || null;
            let needsCapture = false;
            let videoRect = null;

            if (!thumbnail && bestVideo.readyState >= 2) {
                try {
                    const canvas = document.createElement('canvas');
                    const w = 320;
                    const h = (bestVideo.videoHeight / bestVideo.videoWidth) * w;
                    canvas.width = w;
                    canvas.height = h;

                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(bestVideo, 0, 0, w, h);

                    const frameData = ctx.getImageData(0, 0, w, h).data;
                    let totalBrightness = 0;
                    let pixelsScanned = 0;

                    for (let i = 0; i < frameData.length; i += 40) {
                        const r = frameData[i];
                        const g = frameData[i + 1];
                        const b = frameData[i + 2];
                        const brightness = (0.299 * r + 0.587 * g + 0.114 * b);
                        totalBrightness += brightness;
                        pixelsScanned++;
                    }

                    const avgBrightness = pixelsScanned > 0 ? totalBrightness / pixelsScanned : 0;

                    if (avgBrightness > 15) {
                        thumbnail = canvas.toDataURL('image/jpeg', 0.5);
                    } else {
                        // Black frame. Request Viewport Capture!
                        needsCapture = true;
                    }

                } catch (e) {
                    // Tainted (CORS). Request Viewport Capture!
                    needsCapture = true;
                }
            } else if (!thumbnail) {
                // Nothing yet? Capture.
                needsCapture = true;
            }

            if (needsCapture) {
                const r = bestVideo.getBoundingClientRect();
                videoRect = {
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: r.height,
                    dpr: window.devicePixelRatio || 1
                };
            }

            sendResponse({
                duration: bestVideo.duration || 0,
                thumbnail: thumbnail,
                pageTitle: document.title,
                captureRect: videoRect
            });
        } else {
            sendResponse({ duration: 0, thumbnail: null, pageTitle: document.title });
        }
    }
});
