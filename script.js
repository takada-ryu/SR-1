const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const previewContainer = document.getElementById('preview-container');
const controlPanel = document.querySelector('.control-panel');
const previewVideo = document.getElementById('preview-video');
const downloadBtn = document.getElementById('download-btn');
const closePreviewBtn = document.getElementById('close-preview-btn');
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
        download: "DOWNLOAD",
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
        download: "保存",
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
    document.querySelector('.file-name').textContent = `REC_SR1_${ts}.${ext}`;

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
    }
}

function resetUI() {
    previewContainer.classList.add('hidden');
    controlPanel.classList.remove('hidden');
    previewVideo.src = "";
    recordedChunks = [];
    completeBlob = null;
}
