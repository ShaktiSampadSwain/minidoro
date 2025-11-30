import { Plugin } from 'obsidian';

export enum TimerState {
    Work,
    ShortBreak,
    LongBreak,
    Paused,
    Idle
}

export class PomoTimer {
    private state: TimerState = TimerState.Idle;
    private prePauseState: TimerState = TimerState.Idle;
    private remainingTime: number = 0;
    private totalTime: number = 0;
    private targetTime: number | null = null; // New: Tracks the absolute timestamp when timer ends
    private intervalId: number | null = null;
    private onTick: (remainingTime: number, totalTime: number) => void;
    private onStateChange: (state: TimerState) => void;
    private onTimerComplete: () => void;
    private settings: PomodoroSettings;
    private plugin: Plugin;

    constructor(
        plugin: Plugin,
        settings: PomodoroSettings, 
        onTick: (remainingTime: number, totalTime: number) => void, 
        onStateChange: (state: TimerState) => void,
        onTimerComplete: () => void
    ) {
        this.plugin = plugin;
        this.settings = settings;
        this.onTick = onTick;
        this.onStateChange = onStateChange;
        this.onTimerComplete = onTimerComplete;
    }

    public updateSettings(settings: PomodoroSettings) {
        this.settings = settings;
    }

    start(state: TimerState) {
        if (state === TimerState.Idle || state === TimerState.Paused) return;
        
        this.state = state;

        // Only reset time if it's a new session (not resuming)
        // We check <= 0 just to be safe, though usually it's exactly 0 when fresh
        if (this.remainingTime <= 0) {
            switch (this.state) {
                case TimerState.Work: 
                    this.remainingTime = this.settings.workTime * 60; 
                    break;
                case TimerState.ShortBreak: 
                    this.remainingTime = this.settings.shortBreakTime * 60; 
                    break;
                case TimerState.LongBreak: 
                    this.remainingTime = this.settings.longBreakTime * 60; 
                    break;
            }
            this.totalTime = this.remainingTime;
        }
        
        // BACKGROUND FIX:
        // Instead of relying on the interval to count down, we calculate the 
        // specific timestamp when the timer should end.
        this.targetTime = Date.now() + (this.remainingTime * 1000);

        if (this.intervalId) {
            window.clearInterval(this.intervalId);
        }

        // Use plugin.registerInterval to ensure cleanup
        this.intervalId = this.plugin.registerInterval(window.setInterval(() => {
            if (!this.targetTime) return;

            const now = Date.now();
            // Calculate remaining seconds based on real time difference
            // This prevents "drift" if the window is backgrounded/throttled
            const diff = Math.ceil((this.targetTime - now) / 1000);
            
            this.remainingTime = diff;
            this.onTick(this.remainingTime, this.totalTime);
            
            if (this.remainingTime <= 0) {
                // Ensure we don't show negative numbers
                this.remainingTime = 0;
                const completedState = this.state;
                this.stop();
                this.onTimerComplete();
                this.onStateChange(completedState);
            }
        }, 1000));
        
        // Immediate update
        this.onTick(this.remainingTime, this.totalTime);
    }

    pause() {
        if (this.intervalId && this.state !== TimerState.Idle && this.state !== TimerState.Paused) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
            this.prePauseState = this.state;
            this.state = TimerState.Paused;
            this.targetTime = null; // Clear target time as we are no longer running
            // this.remainingTime holds the correct value from the last tick
            this.onTick(this.remainingTime, this.totalTime);
        }
    }

    resume() {
        if (this.state === TimerState.Paused) {
            // When we resume, start() will recalculate a NEW targetTime 
            // based on the current Date.now() + the saved remainingTime
            this.start(this.prePauseState);
        }
    }

    stop() {
        if (this.intervalId) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.state = TimerState.Idle;
        this.remainingTime = 0;
        this.totalTime = 0;
        this.targetTime = null;
        this.onTick(this.remainingTime, this.totalTime);
    }

    reset() {
        this.stop();
        this.onTick(0, 0);
    }

    getState(): TimerState {
        return this.state;
    }

    getRemainingTime(): number {
        return this.remainingTime;
    }

    getTotalTime(): number {
        return this.totalTime;
    }

    isRunning(): boolean {
        return this.state !== TimerState.Idle && this.state !== TimerState.Paused;
    }
}

export interface PomodoroSettings {
    workTime: number;
    shortBreakTime: number;
    longBreakTime: number;
    longBreakInterval: number;
    autoStartBreaks: boolean;
    autoStartPomodoros: boolean;
    showDesktopNotification: boolean;
    playSound: boolean;
    showInStatusBar: boolean;
}

export const DEFAULT_SETTINGS: PomodoroSettings = {
    workTime: 25,
    shortBreakTime: 5,
    longBreakTime: 15,
    longBreakInterval: 4,
    autoStartBreaks: false,
    autoStartPomodoros: false,
    showDesktopNotification: true,
    playSound: true,
    showInStatusBar: false
};