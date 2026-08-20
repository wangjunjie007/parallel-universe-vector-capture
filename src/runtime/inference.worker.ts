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
      try {
        const result = engine.process({ ...message.frame, image: message.image });
        send({ type: 'result', requestId: message.requestId, result });
      } finally {
        // ImageBitmap ownership is transferred to the worker.  The engine
        // closes VideoFrame inputs itself, while worker-only bitmaps need an
        // explicit release after inference to avoid a long-session leak.
        try { message.image.close(); } catch { /* detached or already closed */ }
      }
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
