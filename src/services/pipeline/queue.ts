/**
 * Unified Trip Generation Pipeline — Concurrency Queue
 * FIFO queue with MAX_CONCURRENT_GENERATIONS limit.
 * User sees skeletons while waiting in queue.
 */

const MAX_CONCURRENT_GENERATIONS = parseInt(process.env.MAX_CONCURRENT_GENERATIONS || "3", 10);

let activeGenerations = 0;
const generationQueue: Array<{ resolve: () => void }> = [];

export async function acquireSlot(): Promise<void> {
  if (activeGenerations < MAX_CONCURRENT_GENERATIONS) {
    activeGenerations++;
    return;
  }
  return new Promise((resolve) => generationQueue.push({ resolve }));
}

export function releaseSlot(): void {
  activeGenerations--;
  const next = generationQueue.shift();
  if (next) {
    activeGenerations++;
    next.resolve();
  }
}

export function getQueueStats(): { active: number; queued: number; max: number } {
  return {
    active: activeGenerations,
    queued: generationQueue.length,
    max: MAX_CONCURRENT_GENERATIONS,
  };
}