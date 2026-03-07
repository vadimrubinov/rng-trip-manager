/**
 * Unified Trip Generation Pipeline — BlockEmitter
 * Simple EventEmitter for SSE streaming, in-memory (single-instance on Render).
 */

import { EventEmitter } from "events";
import { BlockEvent } from "./types";

class PipelineEmitter extends EventEmitter {
  emitBlock(projectId: string, event: BlockEvent): void {
    this.emit(projectId, event);
  }
}

export const pipelineEmitter = new PipelineEmitter();
pipelineEmitter.setMaxListeners(100);