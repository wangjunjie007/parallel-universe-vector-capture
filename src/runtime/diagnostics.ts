import type { RawFrame, SemanticFrame } from '../core/types';

export interface DiagnosticEvent {
  id: string;
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  frame?: number;
  time?: number;
  details?: Record<string, unknown>;
}

export class DiagnosticsCollector {
  private readonly events: DiagnosticEvent[] = [];
  private startedAt = performance.now();
  private processed = 0;
  private dropped = 0;
  private inferenceTotalMs = 0;

  add(event: Omit<DiagnosticEvent, 'id'>): void {
    this.events.push({ ...event, id: `${event.code}-${this.events.length + 1}` });
  }

  recordInference(durationMs: number, dropped = false): void {
    if (dropped) this.dropped += 1;
    else { this.processed += 1; this.inferenceTotalMs += durationMs; }
  }

  ingestRaw(frame: RawFrame): void {
    if (frame.flags?.dropped) this.add({ severity: 'warning', code: 'dropped_frame', message: 'A source frame was not processed.', frame: frame.frame, time: frame.time });
    if (frame.flags?.identityAmbiguous) this.add({ severity: 'warning', code: 'identity_ambiguous', message: 'Hand identity could not be confirmed.', frame: frame.frame, time: frame.time });
    if (frame.flags?.identityReset?.length) this.add({ severity: 'warning', code: 'identity_reset', message: 'A hand identity was reset after a long disappearance.', frame: frame.frame, time: frame.time });
    for (const error of frame.flags?.errors ?? []) this.add({ severity: 'error', code: 'frame_error', message: error, frame: frame.frame, time: frame.time });
  }

  ingestSemantic(frame: SemanticFrame): void {
    for (const transition of frame.transitions) this.add({ severity: 'info', code: transition.type, message: transition.type, frame: transition.frame, time: transition.time, details: { side: transition.side, count: transition.count } });
    if (frame.flags.longGap) this.add({ severity: 'warning', code: 'long_gap', message: 'A gap exceeded the interpolation limit and needs review.', frame: frame.frame, time: frame.time });
    if (frame.flags.needsReview) this.add({ severity: 'warning', code: 'needs_review', message: 'This semantic frame is not safe to treat as final geometry.', frame: frame.frame, time: frame.time });
  }

  snapshot(): { events: DiagnosticEvent[]; quality: Record<string, unknown> } {
    const elapsed = Math.max(1, performance.now() - this.startedAt);
    return {
      events: [...this.events],
      quality: {
        processed_frames: this.processed,
        dropped_frames: this.dropped,
        average_inference_ms: this.processed ? this.inferenceTotalMs / this.processed : undefined,
        wall_clock_fps: this.processed * 1000 / elapsed,
        needs_review: this.events.some((event) => event.severity !== 'info'),
      },
    };
  }

  clear(): void {
    this.events.length = 0;
    this.startedAt = performance.now();
    this.processed = 0;
    this.dropped = 0;
    this.inferenceTotalMs = 0;
  }
}
