let recorder: MediaRecorder | undefined;
let stream: MediaStream | undefined;
let audioContext: AudioContext | undefined;
let chunks: Blob[] = [];

chrome.runtime.onMessage.addListener(
  (
    message: { target?: string; type: string; streamId?: string },
    _sender,
    sendResponse: (response: { success: boolean }) => void,
  ) => {
    if (message.target !== 'offscreen') return;

    if (message.type === 'START_TAB_AUDIO_CAPTURE' && message.streamId) {
      startRecording(message.streamId);
      sendResponse({ success: true });
    } else if (message.type === 'STOP_TAB_AUDIO_CAPTURE') {
      stopRecording();
      sendResponse({ success: true });
    }
    return true;
  },
);

async function startRecording(streamId: string) {
  try {
    if (recorder) return;

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      } as MediaTrackConstraints,
      video: false,
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) throw new Error('The tab has no capturable audio track');

    const mimeType = getAudioRecordingMimeType();
    if (!mimeType) throw new Error('This browser cannot encode an audio recording');

    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
    chunks = [];
    recorder = new MediaRecorder(new MediaStream(audioTracks), { mimeType });
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => finishRecording(mimeType));
    recorder.start();
    await chrome.runtime.sendMessage({
      target: 'background',
      type: 'TAB_AUDIO_CAPTURE_STARTED',
      mimeType,
    });
  } catch (error) {
    cleanup();
    await chrome.runtime.sendMessage({
      target: 'background',
      type: 'TAB_AUDIO_CAPTURE_ERROR',
      error: formatError(error),
    });
  }
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  } else {
    cleanup();
  }
}

function finishRecording(mimeType: string) {
  const blob = new Blob(chunks, { type: mimeType });
  const reader = new FileReader();
  reader.addEventListener('loadend', async () => {
    cleanup();
    await chrome.runtime.sendMessage({
      target: 'background',
      type: 'TAB_AUDIO_CAPTURE_COMPLETE',
      data: String(reader.result),
      mimeType,
    });
  });
  reader.readAsDataURL(blob);
}

function cleanup() {
  stream?.getTracks().forEach((track) => track.stop());
  void audioContext?.close();
  recorder = undefined;
  stream = undefined;
  audioContext = undefined;
  chunks = [];
}

function getAudioRecordingMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function formatError(error: unknown) {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
