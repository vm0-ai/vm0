/**
 * Timing utility for debug command output
 */
export class Timer {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Get elapsed time formatted as [MM:SS.mmm]
   */
  elapsed(): string {
    const ms = Date.now() - this.startTime;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}]`;
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
