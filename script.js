const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const previewContainer = document.getElementById('preview-container');
const controlPanel = document.querySelector('.control-panel');
const previewVideo = document.getElementById('preview-video');
const downloadBtn = document.getElementById('download-btn');
const closePreviewBtn = document.getElementById('close-preview-btn');
const backToHistoryBtn = document.getElementById('back-to-history-btn');
const fileInfo = document.getElementById('file-info');
const historyBtn = document.getElementById('history-btn');
const historyPanel = document.getElementById('history-panel');
const historyList = document.getElementById('history-list');
const closeHistoryBtn = document.getElementById('close-history-btn');
const statusText = document.querySelector('.status-text');
const statusIndicator = document.getElementById('status-indicator');
const audioToggle = document.getElementById('audio-toggle');
const sysAudioToggle = document.getElementById('system-audio-toggle');
const langToggle = document.getElementById('lang-toggle');

const translations = {
    en: {
        status_ready: "READY",
        status_rec: "REC",
        frame_rate: "FRAME RATE",
        resolution: "RESOLUTION",
        microphone: "MICROPHONE",
        system_audio: "SYSTEM AUDIO",
        rec: "REC",
        stop: "STOP",
        history: "HISTORY",
        download: "DOWNLOAD",
        back: "BACK",
        view: "VIEW",
        empty_history: "No history yet.",
        close: "CLOSE",
        mic_error: "Microphone access failed. Recording video only."
    },
    ja: {
        status_ready: "準備完了",
        status_rec: "録画中",
        frame_rate: "フレームレート",
        resolution: "解像度",
        microphone: "マイク",
        system_audio: "システム音声",
        rec: "録画",
        stop: "停止",
        history: "履歴",
        download: "保存",
        back: "戻る",
        view: "閲覧",
        empty_history: "履歴はまだありません。",
        close: "閉じる",
        mic_error: "マイクへのアクセスに失敗しました。映像のみ録画します。"
    }
};

let currentLang = 'en';

function setLanguage(lang) {
    currentLang = lang;
    document.documentElement.lang = lang;
    langToggle.textContent = lang === 'en' ? 'JP' : 'EN';

    // Update all data-i18n elements
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        if (translations[lang][key]) {
            element.textContent = translations[lang][key];
        }
    });

    // Update status text specifically if needed (handling dynamic state)
    // But since status-text has data-i18n, it might be overwritten by "READY" or "REC" based on state.
    // We should ensure updateUIState uses the translation.
    // Re-run updateUIState to refresh dynamic text if needed, but easier to just let the next update handle it or handle it here.
    const isRecording = statusIndicator.classList.contains('recording');
    statusText.textContent = isRecording ? translations[lang].status_rec : translations[lang].status_ready;

    if (historyPanel && !historyPanel.classList.contains('hidden')) {
        openHistory();
    }
}

langToggle.addEventListener('click', () => {
    const newLang = currentLang === 'en' ? 'ja' : 'en';
    setLanguage(newLang);
});

let mediaRecorder;
let recordedChunks = [];
let completeBlob = null;
let stream = null;
let audioContext = null;
let audioSources = [];
let previewSource = 'recording';

const HISTORY_DB_NAME = 'sr1_history_db';
const HISTORY_STORE_NAME = 'recordings';
const HISTORY_MAX_ITEMS = 100;

function openHistoryDB() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            reject(new Error('IndexedDB not supported'));
            return;
        }

        const req = indexedDB.open(HISTORY_DB_NAME, 1);

        req.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
                const store = db.createObjectStore(HISTORY_STORE_NAME, { keyPath: 'id' });
                store.createIndex('createdAt', 'createdAt', { unique: false });
            }
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveToHistory(item) {
    const db = await openHistoryDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE_NAME, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(HISTORY_STORE_NAME).put(item);
    });
    await trimHistory();
}

async function trimHistory() {
    const db = await openHistoryDB();
    const items = await getHistoryItems();
    if (items.length <= HISTORY_MAX_ITEMS) return;

    const toDelete = items.slice(HISTORY_MAX_ITEMS);
    await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE_NAME, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        const store = tx.objectStore(HISTORY_STORE_NAME);
        toDelete.forEach(item => store.delete(item.id));
    });
}

async function getHistoryItems() {
    const db = await openHistoryDB();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE_NAME, 'readonly');
        const store = tx.objectStore(HISTORY_STORE_NAME);
        const index = store.index('createdAt');
        const items = [];
        const cursorReq = index.openCursor(null, 'prev');

        cursorReq.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                items.push(cursor.value);
                cursor.continue();
            } else {
                resolve(items);
            }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
    });
}

async function getHistoryItem(id) {
    const db = await openHistoryDB();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE_NAME, 'readonly');
        const req = tx.objectStore(HISTORY_STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < sizes.length - 1) {
        val /= 1024;
        i++;
    }
    return `${val.toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

function formatDate(ts) {
    try {
        const d = new Date(ts);
        return d.toLocaleString();
    } catch (_) {
        return '';
    }
}

// Check for MP4 support
const types = [
    "video/mp4;codecs=avc1,mp4a.40.2", // H.264 + AAC (Best for Windows)
    "video/mp4",
    "video/webm;codecs=h264",
    "video/webm;codecs=vp9,opus",
    "video/webm"
];
let selectedType = "";
for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) {
        selectedType = t;
        break;
    }
}

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
downloadBtn.addEventListener('click', downloadVideo);
closePreviewBtn.addEventListener('click', resetUI);
historyBtn.addEventListener('click', openHistory);
closeHistoryBtn.addEventListener('click', closeHistory);
backToHistoryBtn.addEventListener('click', backToHistory);

async function startRecording() {
    try {
        const useMic = audioToggle.checked;
        const useSysAudio = sysAudioToggle.checked;

        // 1. Get Display Media (Screen + potentially System Audio)
        // Note: 'systemAudio' constraint is 'include' in some browsers, but mostly controlled by UI checkbox in popup
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 60 }
            },
            audio: useSysAudio // Request system audio sharing
        });

        // If user cancelled screen share dialog
        displayStream.getVideoTracks()[0].onended = () => {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                stopRecording();
            }
        };

        let finalStream = displayStream;

        // 2. Setup Audio Mixing if needed
        if (useMic) {
            try {
                const micStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        sampleRate: 44100
                    }
                });

                // We need to mix them
                audioContext = new (window.AudioContext || window.webkitAudioContext)();

                // Destination stream
                const dest = audioContext.createMediaStreamDestination();

                // Add mic
                const micSrc = audioContext.createMediaStreamSource(micStream);
                micSrc.connect(dest);
                audioSources.push(micSrc);

                // Add system audio if present in displayStream
                // displayStream.getAudioTracks() might be empty if user unchecked "Share Audio" in browser modal
                if (displayStream.getAudioTracks().length > 0) {
                    const sysSrc = audioContext.createMediaStreamSource(displayStream);
                    sysSrc.connect(dest);
                    audioSources.push(sysSrc);
                    // Remove original audio tracks from final stream so we don't duplicate or have conflicts
                    // actually simpler to just compose a new MediaStream
                }

                const mixedAudioTracks = dest.stream.getAudioTracks();
                const videoTracks = displayStream.getVideoTracks();

                finalStream = new MediaStream([...videoTracks, ...mixedAudioTracks]);

            } catch (err) {
                console.warn("Mic access denied or error:", err);
                alert(translations[currentLang].mic_error);
            }
        }

        stream = finalStream;

        // 3. Start Recording
        mediaRecorder = new MediaRecorder(stream, {
            mimeType: selectedType,
            videoBitsPerSecond: 8000000 // 8Mbps for high quality
        });

        recordedChunks = [];
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                recordedChunks.push(e.data);
            }
        };

        mediaRecorder.onstop = handleStop;

        mediaRecorder.start(100); // 100ms chunks

        // UI Updates
        updateUIState(true);

    } catch (err) {
        console.error("Error starting recording:", err);
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }

    // Stop tracks
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
}

function handleStop() {
    completeBlob = new Blob(recordedChunks, { type: selectedType });
    const videoURL = URL.createObjectURL(completeBlob);

    previewVideo.src = videoURL;

    // Determine extension
    const ext = selectedType.includes("mp4") ? "mp4" : "webm";

    // Update Filename with timestamp
    const date = new Date();
    const ts = `${date.getHours()}${date.getMinutes()}_${date.getDate()}`;
    const fileName = `REC_SR1_${ts}.${ext}`;
    document.querySelector('.file-name').textContent = fileName;

    previewSource = 'recording';
    backToHistoryBtn.classList.add('hidden');

    saveToHistory({
        id: Date.now(),
        name: fileName,
        createdAt: new Date().toISOString(),
        type: selectedType,
        size: completeBlob.size,
        blob: completeBlob
    }).catch(() => { });

    updateUIState(false);
}

function downloadVideo() {
    if (!completeBlob) return;

    const url = URL.createObjectURL(completeBlob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = document.querySelector('.file-name').textContent; // Force .mp4/webm name
    document.body.appendChild(a);
    a.click();

    // Cleanup
    setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 100);
}

function updateUIState(isRecording) {
    if (isRecording) {
        startBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        controlPanel.classList.add('recording-mode'); // Optional style hook
        statusIndicator.classList.add('recording');
        statusText.textContent = translations[currentLang].status_rec;

        // Hide settings during recording if desired, or keep them
        // For simple nothing style, maybe keep it minimal
        document.querySelectorAll('.settings-group').forEach(el => el.style.opacity = '0.5');
        document.querySelectorAll('input').forEach(el => el.disabled = true);

    } else {
        startBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        statusIndicator.classList.remove('recording');
        statusText.textContent = translations[currentLang].status_ready;

        document.querySelectorAll('.settings-group').forEach(el => el.style.opacity = '1');
        document.querySelectorAll('input').forEach(el => el.disabled = false);

        // Show preview
        controlPanel.classList.add('hidden');
        previewContainer.classList.remove('hidden');
        fileInfo.classList.remove('hidden');
    }
}

function resetUI() {
    previewContainer.classList.add('hidden');
    controlPanel.classList.remove('hidden');
    historyPanel.classList.add('hidden');
    previewVideo.src = "";
    recordedChunks = [];
    completeBlob = null;
    previewSource = 'recording';
    backToHistoryBtn.classList.add('hidden');
}

async function openHistory() {
    try {
        const items = await getHistoryItems();
        renderHistory(items.slice(0, HISTORY_MAX_ITEMS));
    } catch (_) {
        renderHistory([]);
    }

    controlPanel.classList.add('hidden');
    previewContainer.classList.add('hidden');
    historyPanel.classList.remove('hidden');
}

function closeHistory() {
    historyPanel.classList.add('hidden');
    controlPanel.classList.remove('hidden');
}

function backToHistory() {
    previewContainer.classList.add('hidden');
    historyPanel.classList.remove('hidden');
    openHistory();
}

function renderHistory(items) {
    historyList.innerHTML = '';

    if (!items || items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'history-item';
        const meta = document.createElement('div');
        meta.className = 'history-meta';
        const name = document.createElement('div');
        name.className = 'history-name dot-font';
        name.textContent = translations[currentLang].empty_history;
        meta.appendChild(name);
        empty.appendChild(meta);
        historyList.appendChild(empty);
        return;
    }

    items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'history-item';

        const meta = document.createElement('div');
        meta.className = 'history-meta';

        const name = document.createElement('div');
        name.className = 'history-name dot-font';
        name.textContent = item.name || 'REC';

        const sub = document.createElement('div');
        sub.className = 'history-sub';
        sub.textContent = `${formatDate(item.createdAt)}  ${formatBytes(item.size)}`;

        meta.appendChild(name);
        meta.appendChild(sub);

        const actions = document.createElement('div');
        actions.className = 'history-actions';

        const viewBtn = document.createElement('button');
        viewBtn.className = 'close-btn dot-font';
        viewBtn.textContent = translations[currentLang].view;
        viewBtn.addEventListener('click', async () => {
            const full = await getHistoryItem(item.id);
            if (!full || !full.blob) return;

            completeBlob = full.blob;
            const url = URL.createObjectURL(completeBlob);
            previewVideo.src = url;
            document.querySelector('.file-name').textContent = full.name || 'REC';
            previewSource = 'history';
            backToHistoryBtn.classList.remove('hidden');

            historyPanel.classList.add('hidden');
            previewContainer.classList.remove('hidden');
            fileInfo.classList.remove('hidden');
        });

        const dlBtn = document.createElement('button');
        dlBtn.className = 'download-btn dot-font';
        dlBtn.textContent = translations[currentLang].download;
        dlBtn.addEventListener('click', async () => {
            const full = await getHistoryItem(item.id);
            if (!full || !full.blob) return;
            downloadBlob(full.blob, full.name || 'REC');
        });

        actions.appendChild(viewBtn);
        actions.appendChild(dlBtn);

        row.appendChild(meta);
        row.appendChild(actions);
        historyList.appendChild(row);
    });
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 100);
}
