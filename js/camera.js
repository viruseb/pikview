/** Accès à la caméra du téléphone. */

let stream = null;
let facing = 'environment';

export function isSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export async function start(video, { facingMode = facing } = {}) {
  await stop();
  facing = facingMode;
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 2560 },
      height: { ideal: 1440 },
    },
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    } else {
      throw err;
    }
  }
  video.srcObject = stream;
  await video.play();
  return stream;
}

export async function stop() {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
}

export function currentFacing() {
  return facing;
}

export async function flip(video) {
  return start(video, { facingMode: facing === 'environment' ? 'user' : 'environment' });
}

export function torchSupported() {
  if (!stream) return false;
  const track = stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : null;
  return !!(caps && 'torch' in caps);
}

export async function setTorch(on) {
  if (!stream) return false;
  const track = stream.getVideoTracks()[0];
  try {
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    return true;
  } catch {
    return false;
  }
}
