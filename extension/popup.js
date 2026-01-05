document.addEventListener('DOMContentLoaded', () => {
    const list = document.getElementById('video-list');
    const emptyState = document.getElementById('empty-state');

    // Request detected videos from Background script
    chrome.runtime.sendMessage({ action: 'GET_VIDEOS' }, (response) => {
        if (response && response.videos && response.videos.length > 0) {
            emptyState.style.display = 'none';
            renderVideos(response.videos);
        } else {
            emptyState.style.display = 'block';
        }
    });

    // Reset Counter Button
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'RESET_COUNTER' }, (res) => {
                if (res && res.status === 'reset') {
                     const original = resetBtn.innerHTML;
                     resetBtn.innerHTML = '<span style="font-size:10px;color:#40c057">OK</span>';
                     setTimeout(() => resetBtn.innerHTML = original, 1000);
                }
            });
        });
    }

    // Listen for Progress Updates
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'DOWNLOAD_PROGRESS') {
            updateProgressUI(message.url, message.percent, message.speed, message.status);
        }
        else if (message.action === 'DOWNLOAD_complete' || message.action === 'DOWNLOAD_error') {
            resetProgressUI(message.url);
        }
    });

    function updateProgressUI(url, percent, speed, status) {
        const card = document.querySelector(`.video-item[data-url="${url}"]`);
        if (!card) return;

        const controls = card.querySelector('.controls');
        const progressPanel = card.querySelector('.progress-panel');
        const progressBar = card.querySelector('.progress-bar');
        const progressInfo = card.querySelector('.progress-info');

        controls.style.display = 'none';
        progressPanel.style.display = 'flex';
        progressBar.style.width = `${percent}%`;
        progressInfo.innerHTML = `<span>${percent}%</span> <span>${speed || ''}</span>`;
    }

    function resetProgressUI(url) {
        const card = document.querySelector(`.video-item[data-url="${url}"]`);
        if (!card) return;

        const controls = card.querySelector('.controls');
        const progressPanel = card.querySelector('.progress-panel');

        setTimeout(() => {
            progressPanel.style.display = 'none';
            controls.style.display = 'flex';
        }, 2000);
    }

    function formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return '00:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    function renderVideos(videos) {
        list.innerHTML = '';
        videos.forEach((video, index) => {
            const li = document.createElement('div');
            li.className = 'video-item';
            li.setAttribute('data-url', video.url);

            const typeLabel = video.type.toUpperCase();
            let sizeStr = '';
            if (video.type === 'hls' || video.type === 'dash') {
                sizeStr = 'Stream';
            } else {
                sizeStr = video.size ? (video.size / 1024 / 1024).toFixed(1) + 'MB' : '';
            }

            // Thumbnail Logic
            const thumbSrc = video.thumbnail || 'icons/icon48.png';
            // Duration Logic
            const durationStr = formatDuration(video.duration);

            li.innerHTML = `
        <div class="card-top">
            <div class="thumbnail">
                <img src="${thumbSrc}" alt="thumb" style="${!video.thumbnail ? 'width:32px;height:32px;object-fit:contain;' : ''}"> 
                <span class="thumbnail-overlay">${durationStr}</span>
            </div>
            
            <div class="content">
                <div>
                    <div class="title-row">
                        <span class="badge ${video.type}">${typeLabel}</span>
                        <div class="video-title" title="${video.url}">${video.pageTitle || video.filename || 'Untitled Video'}</div>
                    </div>
                    <div class="extension-tag">${video.filename || 'video.mp4'} • ${sizeStr}</div>
                </div>
            </div>
        </div>

        <div class="controls">
            <button class="edit-btn" title="Rename Video">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            
            <div class="quality-selector" title="Select Quality">
                <span class="quality-text">Auto / Best</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
                <div class="quality-dropdown" style="display:none; position:absolute; top:100%; left:0; right:0; background:#343a40; border:1px solid #495057; z-index:10; max-height:150px; overflow-y:auto; border-radius:4px;"></div>
            </div>

            <div class="download-group">
                <button class="main-download-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    Download
                </button>
                <button class="more-options-btn" title="Copy URL">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
                </button>
            </div>
        </div>

        <div class="progress-panel">
            <div class="progress-track">
                <div class="progress-bar"></div>
                <div class="progress-info">
                   <span>0%</span> <span>0 KB/s</span>
                </div>
            </div>
            <button class="stop-btn">Stop</button>
        </div>
      `;

            const titleEl = li.querySelector('.video-title');
            const editBtn = li.querySelector('.edit-btn');
            const qualityBtn = li.querySelector('.quality-selector');
            const qualityText = li.querySelector('.quality-text');
            const qualityDropdown = li.querySelector('.quality-dropdown');
            const downloadBtn = li.querySelector('.main-download-btn');
            const moreBtn = li.querySelector('.more-options-btn');
            const stopBtn = li.querySelector('.stop-btn');

            let currentFilename = video.pageTitle || video.filename || 'video';
            let selectedUrl = video.url;

            editBtn.addEventListener('click', () => {
                if (titleEl.querySelector('input')) return;
                const input = document.createElement('input');
                input.type = 'text';
                input.value = currentFilename;
                input.style.width = '100%';
                input.style.background = '#343a40';
                input.style.border = '1px solid #22b8cf';
                input.style.color = '#fff';
                input.style.padding = '2px';
                input.style.fontSize = '12px';

                const save = () => {
                    const newVal = input.value.trim();
                    if (newVal) {
                        currentFilename = newVal;
                        titleEl.textContent = newVal;
                    } else {
                        titleEl.textContent = currentFilename;
                    }
                };

                input.addEventListener('blur', save);
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { save(); input.blur(); }
                });

                titleEl.innerHTML = '';
                titleEl.appendChild(input);
                input.focus();
            });

            if (video.type === 'hls') {
                qualityBtn.style.cursor = 'pointer';
                qualityBtn.style.position = 'relative';

                let variantsCached = null;

                qualityBtn.addEventListener('click', (e) => {
                    if (e.target.closest('.quality-dropdown')) return;

                    // Close OTHER dropdowns first
                    const isVisible = qualityDropdown.style.display === 'block';

                    // Reset all z-index states
                    document.querySelectorAll('.video-item.z-active').forEach(el => el.classList.remove('z-active'));
                    document.querySelectorAll('.quality-dropdown').forEach(el => el.style.display = 'none');

                    if (!isVisible) {
                        // Opening this one
                        qualityDropdown.style.display = 'block';
                        li.classList.add('z-active'); // Bring to front

                        if (!variantsCached) {
                            qualityText.textContent = 'Loading...';
                            chrome.runtime.sendMessage({ action: 'GET_VARIANTS', url: video.url, tabId: video.tabId }, (response) => {
                                if (response && response.variants && response.variants.length > 0) {
                                    variantsCached = response.variants;
                                    renderDropdown(variantsCached);
                                    qualityText.textContent = 'Select Quality';
                                } else {
                                    qualityText.textContent = 'Auto / Best';
                                    qualityDropdown.innerHTML = '<div style="padding:4px; color:#adb5bd; font-size:10px;">No variants found (Auto)</div>';
                                }
                            });
                        } else {
                            qualityDropdown.style.display = 'block'; // Re-show cached
                        }
                    }
                });

                function renderDropdown(variants) {
                    qualityDropdown.innerHTML = '';
                    variants.forEach(v => {
                        const item = document.createElement('div');
                        item.textContent = v.quality; // Now contains size string from background
                        item.style.padding = '4px 8px';
                        item.style.cursor = 'pointer';
                        item.style.color = '#e9ecef';
                        item.style.fontSize = '12px';
                        item.style.borderBottom = '1px solid #495057';

                        item.addEventListener('mouseenter', () => item.style.background = '#495057');
                        item.addEventListener('mouseleave', () => item.style.background = 'transparent');

                        item.addEventListener('click', () => {
                            selectedUrl = v.url;
                            qualityText.textContent = v.quality.split('•')[0].trim(); // Show just resolution in box
                            qualityDropdown.style.display = 'none';
                            li.classList.remove('z-active');
                        });

                        qualityDropdown.appendChild(item);
                    });
                }

                document.addEventListener('click', (e) => {
                    if (!qualityBtn.contains(e.target)) {
                        qualityDropdown.style.display = 'none';
                        li.classList.remove('z-active');
                    }
                });
            } else {
                qualityBtn.style.opacity = '0.5';
                qualityBtn.title = 'Quality selection only for HLS';
            }

            downloadBtn.addEventListener('click', (e) => {
                const safeVideo = {
                    url: selectedUrl,
                    filename: currentFilename,
                    type: video.type,
                    tabId: video.tabId,
                    pageTitle: currentFilename
                };

                chrome.runtime.sendMessage({
                    action: 'DOWNLOAD_MEDIA',
                    video: safeVideo
                });
            });

            moreBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(selectedUrl).then(() => {
                    const original = moreBtn.innerHTML;
                    moreBtn.innerHTML = '<span style="font-size:10px">Copied</span>';
                    setTimeout(() => {
                        if (document.body.contains(moreBtn)) moreBtn.innerHTML = original;
                    }, 1000);
                });
            });

            stopBtn.addEventListener('click', () => {
                chrome.runtime.sendMessage({
                    action: 'CANCEL_DOWNLOAD',
                    url: selectedUrl
                });
                stopBtn.textContent = 'Stopping...';
            });


            list.appendChild(li);
        });
    }
});
