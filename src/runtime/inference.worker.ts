import { HandLandmarkerEngine } from './handLandmarkerEngine';
import type {
  InferenceWorkerMessage,
  InferenceWorkerResponse,
} from './protocol';

const engine = new HandLandmarkerEngine();

const send = (message: InferenceWorkerResponse, transfer: Transferable[] = []) => {
  (self as unknown as Worker).postMessage(message, transfer);
};

self.onmessage = async (event: MessageEvent<InferenceWorkerMessage>) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      const result = await engine.init(message.options);
      send({ type: 'ready', requestId: message.requestId, result });
      return;
    }
    if (message.type === 'frame') {
      // HandLandmarkerEngine owns the transferred frame for the entire process
      // call and releases it in a finally block on success and failure. Keep a
      // single owner here so a strict VideoFrame/ImageBitmap implementation is
      // not closed twice.
      const result = engine.process({ ...message.frame, image: message.image });
      send({ type: 'result', requestId: message.requestId, result });
      return;
    }
    engine.close();
    self.close();
  } catch (error) {
    send({
      type: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
      code: 'INFERENCE_FAILURE',
    });
  }
};
