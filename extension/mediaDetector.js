/**
 * Media Detection Module
 * Analyzes HTTP response headers and URLs to identify video streams.
 */

export const MediaTypes = {
  HLS: 'hls',
  DASH: 'dash',
  MP4: 'mp4',
  WEBM: 'webm',
  UNKNOWN: 'unknown'
};

export function detectMediaType(details) {
  const { url, responseHeaders } = details;
  
  // 1. Check MIME types in headers
  const contentTypeHeader = responseHeaders.find(h => h.name.toLowerCase() === 'content-type');
  const contentType = contentTypeHeader ? contentTypeHeader.value.toLowerCase() : '';

  if (contentType.includes('application/x-mpegurl') || contentType.includes('application/vnd.apple.mpegurl')) {
    return MediaTypes.HLS;
  }
  if (contentType.includes('application/dash+xml')) {
    return MediaTypes.DASH;
  }
  if (contentType.includes('video/mp4')) {
    return MediaTypes.MP4;
  }
  if (contentType.includes('video/webm')) {
    return MediaTypes.WEBM;
  }

  // 2. Check URL extensions (fallback)
  const cleanUrl = url.split('?')[0].toLowerCase();
  
  if (cleanUrl.endsWith('.m3u8')) return MediaTypes.HLS;
  if (cleanUrl.endsWith('.mpd')) return MediaTypes.DASH;
  if (cleanUrl.endsWith('.mp4')) return MediaTypes.MP4;
  if (cleanUrl.endsWith('.webm')) return MediaTypes.WEBM;

  return null;
}

export function extractMetadata(details, type) {
  const { url, responseHeaders } = details;
  const contentLength = responseHeaders.find(h => h.name.toLowerCase() === 'content-length');
  const size = contentLength ? parseInt(contentLength.value, 10) : 0;

  // Attempt to guess filename from URL
  const urlParts = url.split('?')[0].split('/');
  let filename = urlParts[urlParts.length - 1];
  if (!filename || filename.length > 50) filename = `video_${Date.now()}`;

  // For playlists, filename might be master.m3u8, we typically want the page title but that's in the tab.
  // We'll update title later from the tab info.

  return {
    url,
    type,
    filename,
    size,
    headers: responseHeaders // Store headers if auth tokens are needed for download
  };
}
