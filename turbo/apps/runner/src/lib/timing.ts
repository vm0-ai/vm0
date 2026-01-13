/**
 * Timing utility for debug command output
 */
export class Timer {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Get elapsed time formatted as [MM:SS.s]
   */
  elapsed(): string {
    const ms = Date.now() - this.startTime;
    const totalSeconds = ms / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = (totalSeconds % 60).toFixed(1);
    return `[${String(minutes).padStart(2, "0")}:${seconds.padStart(4, "0")}]`;
  }

  /**
   * Log message with timestamp
   */
  log(message: string): void {
    console.log(`${this.elapsed()} ${message}`);
  }

  /**
   * Get total elapsed time in seconds
   */
  totalSeconds(): number {
    return (Date.now() - this.startTime) / 1000;
  }
}
