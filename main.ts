import { App, Plugin, PluginSettingTab, Setting, Notice, WorkspaceLeaf, addIcon, setIcon } from 'obsidian';
import { PomoTimer, TimerState, PomodoroSettings, DEFAULT_SETTINGS } from './PomoTimer';

export default class PomodoroPlugin extends Plugin {
    settings: PomodoroSettings;
    private timer: PomoTimer;
    private currentMode: TimerState = TimerState.Work;
    private completedPomodoros: number = 0;
    private nextMode: TimerState = TimerState.ShortBreak;
    private isSessionComplete: boolean = false;

    // UI Elements
    private containerEl: HTMLDivElement | null = null;
    private controlPanelEl: HTMLDivElement | null = null;
    private pieCircleEl: SVGCircleElement | null = null;
    private panelTimeEl: HTMLButtonElement | null = null;
    private panelModeEl: HTMLDivElement | null = null;
    private isPanelPinned = false;
    private hideTimeout: number | null = null;

    async onload() {
        await this.loadSettings();

        // Register the custom timer icon (SVG structure)
        addIcon('minidoro-timer', `
            <svg viewBox="0 0 20 20" class="minidoro-pie-chart">
                <circle class="minidoro-progress-track" cx="10" cy="10" r="8" fill="transparent" stroke-width="4"></circle>
                <circle class="minidoro-progress-circle" cx="10" cy="10" r="8" fill="transparent" stroke-width="4"></circle>
            </svg>
        `);

        this.timer = new PomoTimer(
            this, // Pass plugin instance for registerInterval
            this.settings,
            (remaining, total) => this.updateUI(remaining, total),
            (state) => this.onTimerCompletion(state),
            () => this.onTimerComplete()
        );

        this.addSettingTab(new PomodoroSettingTab(this.app, this));
        
        // Register commands for keyboard shortcuts
        this.addCommand({
            id: 'start-pause-timer',
            name: 'Start/pause timer',
            callback: () => {
                this.handlePauseResumeClick();
            }
        });

        this.addCommand({
            id: 'reset-timer',
            name: 'Reset timer',
            callback: () => {
                this.handleResetClick();
            }
        });

        this.addCommand({
            id: 'switch-mode',
            name: 'Switch mode',
            callback: () => {
                this.handleCycleModeClick();
            }
        });

        // Register active leaf change event
        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => this.refreshHeaderButton(leaf)));
        this.app.workspace.onLayoutReady(() => this.refreshHeaderButton());

        // Register DOM event for document click to ensure cleanup
        this.registerDomEvent(document, 'click', (event: MouseEvent) => {
            this.handleDocumentClick(event);
        });

        // Request notification permission on startup
        if ('Notification' in window && Notification.permission === 'default') {
            void Notification.requestPermission().catch(err => console.error("Minidoro: Error requesting notification permission", err));
        }
    }

    onunload() {
        // Clear any pending timeouts
        if (this.hideTimeout !== null) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
        
        this.removeHeaderButton();
        this.timer.stop();
    }

    async loadSettings() { 
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); 
    }
    
    async saveSettings() { 
        await this.saveData(this.settings); 
        this.timer.updateSettings(this.settings); 
        this.updateUI(0, 0); 
    }

    private refreshHeaderButton(leaf: WorkspaceLeaf | null = null) {
        this.removeHeaderButton();
        
        // Fixed: activeLeaf is deprecated. Use getLeaf(false) to get the most recent leaf.
        const targetLeaf = leaf || this.app.workspace.getLeaf(false);
        
        if (!targetLeaf) return;

        setTimeout(() => {
            // Check if view exists on the leaf
            if (!targetLeaf.view) return;
            
            const actionsContainer = targetLeaf.view.containerEl.querySelector('.view-actions');
            if (actionsContainer && !actionsContainer.querySelector('.minidoro-container')) {
                this.createHeaderButton(actionsContainer);
                this.updateUI(0, 0);
            }
        }, 0);
    }

    private createHeaderButton(parent: Element) {
        this.containerEl = parent.createEl('div', { cls: 'minidoro-container' });

        // Event Listeners for Hover
        this.containerEl.addEventListener('mouseenter', this.showPanel);
        this.containerEl.addEventListener('mouseleave', this.hidePanel);

        const pieButton = this.containerEl.createEl('button', { cls: 'minidoro-pie-button' });
        pieButton.setAttribute('aria-label', 'Pomodoro timer');
        pieButton.onclick = (event) => {
            event.stopPropagation();
            if (this.isSessionComplete) {
                this.acknowledgeSessionComplete();
            } else {
                this.isPanelPinned = !this.isPanelPinned;
            }
        };
        
        // SVG Creation using setIcon
        // We use the custom icon registered in onload
        setIcon(pieButton, 'minidoro-timer');

        // Retrieve the reference to the dynamic circle element so we can animate it
        this.pieCircleEl = pieButton.querySelector('.minidoro-progress-circle');
        
        parent.prepend(this.containerEl);
        
        this.createControlPanel();
    }

    private createControlPanel() {
        if (!this.containerEl) return;
        this.controlPanelEl = this.containerEl.createEl('div', { cls: 'minidoro-control-panel' });
        this.panelModeEl = this.controlPanelEl.createEl('div', { 
            cls: 'minidoro-panel-mode', 
            attr: { 
                'title': 'Click to switch mode (only when timer is reset)',
                'role': 'button',
                'tabindex': '0'
            } 
        });
        this.panelModeEl.onclick = () => this.handleCycleModeClick();
        
        this.panelTimeEl = this.controlPanelEl.createEl('button', { 
            cls: 'minidoro-panel-time', 
            // Fixed sentence case here
            attr: { 'title': 'Left click: play/pause | Right click: reset' } 
        });
        this.panelTimeEl.onclick = () => this.handlePauseResumeClick();
        this.panelTimeEl.oncontextmenu = (e) => { 
            e.preventDefault(); 
            this.handleResetClick(); 
        };
    }

    private removeHeaderButton() {
        // Clear any pending hide timeout
        if (this.hideTimeout !== null) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
        
        this.containerEl?.remove();
        this.containerEl = this.controlPanelEl = this.pieCircleEl = this.panelTimeEl = this.panelModeEl = null;
        this.isPanelPinned = false;
    }

    private showPanel = () => {
        if (this.hideTimeout !== null) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
        this.controlPanelEl?.addClass('is-panel-visible');
    };
    
    private hidePanel = () => { 
        if (!this.isPanelPinned) {
            this.hideTimeout = window.setTimeout(() => {
                this.controlPanelEl?.removeClass('is-panel-visible');
                this.hideTimeout = null;
            }, 300);
        }
    };
    
    private handleDocumentClick = (event: MouseEvent) => {
        if (this.containerEl && !this.containerEl.contains(event.target as Node)) {
            if (this.isPanelPinned) {
                this.isPanelPinned = false;
                if (this.hideTimeout !== null) {
                    clearTimeout(this.hideTimeout);
                    this.hideTimeout = null;
                }
                this.controlPanelEl?.removeClass('is-panel-visible');
            }
        }
    };

    private updateUI(remainingTime: number, totalTime: number) {
        if (!this.pieCircleEl || !this.panelTimeEl || !this.panelModeEl) return;

        const timerState = this.timer.getState();
        
        // Remove all mode classes first
        this.pieCircleEl.removeClass('minidoro-work-mode', 'minidoro-break-mode');
        this.panelModeEl.removeClass('minidoro-work-mode', 'minidoro-break-mode', 'mode-enabled', 'mode-disabled');
        this.pieCircleEl.removeClass('minidoro-progress-complete', 'minidoro-progress-idle');

        // Add appropriate mode class
        const isWorkMode = this.currentMode === TimerState.Work;
        const modeClass = isWorkMode ? 'minidoro-work-mode' : 'minidoro-break-mode';
        this.pieCircleEl.addClass(modeClass);
        this.panelModeEl.addClass(modeClass);

        // Update pie chart progress
        const radius = this.pieCircleEl.r.baseVal.value;
        const circumference = 2 * Math.PI * radius;
        
        let progress: number;
        if (timerState === TimerState.Idle) {
            progress = 1; 
            this.pieCircleEl.addClass('minidoro-progress-idle');
        } else {
            progress = totalTime > 0 ? remainingTime / totalTime : 0;
            if (progress <= 0) {
                this.pieCircleEl.addClass('minidoro-progress-complete');
            }
        }

        this.pieCircleEl.style.setProperty('--progress', progress.toString());
        this.pieCircleEl.style.setProperty('--circumference', circumference.toString());

        // Add session complete animation
        if (this.isSessionComplete) {
            this.containerEl?.addClass('session-complete');
        } else {
            this.containerEl?.removeClass('session-complete');
        }

        // Update time display
        const minutes = Math.floor(remainingTime / 60).toString().padStart(2, '0');
        const seconds = (remainingTime % 60).toString().padStart(2, '0');
        
        if (timerState === TimerState.Idle) {
            this.panelTimeEl.setText(this.getIdleTimeText());
        } else {
            this.panelTimeEl.setText(`${minutes}:${seconds}`);
        }

        this.panelModeEl.setText(this.getModeText());

        if (timerState === TimerState.Idle && !this.timer.isRunning()) {
            this.panelModeEl.addClass('mode-enabled');
        } else {
            this.panelModeEl.addClass('mode-disabled');
        }
    }
    
    private getIdleTimeText = (): string => {
        const time = this.currentMode === TimerState.Work 
            ? this.settings.workTime 
            : this.currentMode === TimerState.ShortBreak 
                ? this.settings.shortBreakTime 
                : this.settings.longBreakTime;
        return `${time}:00`;
    };

    private getModeText = (): string => {
        return this.currentMode === TimerState.Work 
            ? 'Focus' 
            : this.currentMode === TimerState.ShortBreak 
                ? 'Short break' 
                : 'Long break';
    };

    private handlePauseResumeClick = () => {
        if (this.isSessionComplete) {
            this.acknowledgeSessionComplete();
            return;
        }

        if (this.timer.isRunning() || this.timer.getState() === TimerState.Paused) {
            if (this.timer.getState() === TimerState.Paused) {
                this.timer.resume();
            } else {
                this.timer.pause();
            }
        } else {
            this.timer.start(this.currentMode);
        }
    };

    private handleResetClick = () => {
        this.timer.reset();
        this.isSessionComplete = false;
        this.updateUI(0, 0);
    };

    private handleCycleModeClick = () => {
        if (this.timer.getState() !== TimerState.Idle || this.timer.isRunning()) {
            new Notice('Reset the timer to switch modes');
            return;
        }

        if (this.isSessionComplete) {
            this.acknowledgeSessionComplete();
            return;
        }

        switch (this.currentMode) {
            case TimerState.Work: 
                this.currentMode = TimerState.ShortBreak; 
                break;
            case TimerState.ShortBreak: 
                this.currentMode = TimerState.LongBreak; 
                break;
            case TimerState.LongBreak: 
                this.currentMode = TimerState.Work; 
                break;
        }
        new Notice(`Switched to ${this.getModeText()} mode`);
        this.updateUI(0, 0);
    };

    private onTimerComplete() {
        this.isSessionComplete = true;
        if (this.settings.playSound) {
            this.playNotificationSound();
        }
        if (this.settings.showDesktopNotification) {
            this.showDesktopNotification();
        }

        const sessionType = this.getModeText();
        new Notice(`${sessionType} session completed!`, 4000);

        this.advanceToNextMode();
        this.updateUI(0, 0);

        setTimeout(() => {
            this.acknowledgeSessionComplete();
        }, 10000);
    }

    private playNotificationSound() {
        try {
            interface WindowWithWebkitAudioContext extends Window {
                webkitAudioContext?: typeof AudioContext;
            }
            
            const windowWithWebkit = window as WindowWithWebkitAudioContext;
            const AudioContextConstructor = window.AudioContext || windowWithWebkit.webkitAudioContext;
            
            if (!AudioContextConstructor) return;
            
            const audioContext = new AudioContextConstructor();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
            oscillator.frequency.setValueAtTime(1200, audioContext.currentTime + 0.2);
            oscillator.type = 'sine';
            
            gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 1);
            
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 1);
        } catch (error) {
            console.warn('Could not play notification sound:', error);
        }
    }

    private showDesktopNotification() {
        if ('Notification' in window && Notification.permission === 'granted') {
            const sessionType = this.getModeText();
            
            const notification = new Notification(`Minidoro - ${sessionType} complete`, {
                body: `Your ${sessionType.toLowerCase()} session is finished.`,
                icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIHN0cm9rZT0iIzY2NiIgc3Ryb2tlLXdpZHRoPSIyIiBmaWxsPSJ0cmFuc3BhcmVudCIvPgo8L3N2Zz4K',
                requireInteraction: false,
                tag: 'pomodoro-timer',
                silent: false
            });

            setTimeout(() => {
                notification.close();
            }, 5000);
        }
    }

    private advanceToNextMode() {
        if (this.currentMode === TimerState.Work) {
            this.completedPomodoros++;
            if (this.completedPomodoros % this.settings.longBreakInterval === 0) {
                this.nextMode = TimerState.LongBreak;
            } else {
                this.nextMode = TimerState.ShortBreak;
            }
        } else {
            this.nextMode = TimerState.Work;
        }

        if ((this.currentMode === TimerState.Work && this.settings.autoStartBreaks) ||
            (this.currentMode !== TimerState.Work && this.settings.autoStartPomodoros)) {
            
            setTimeout(() => {
                if (this.isSessionComplete) {
                    this.currentMode = this.nextMode;
                    this.timer.start(this.currentMode);
                }
            }, 1000);
        }
    }

    private acknowledgeSessionComplete() {
        this.isSessionComplete = false;
        if (!this.timer.isRunning()) {
            this.currentMode = this.nextMode;
        }
        this.updateUI(this.timer.getRemainingTime(), this.timer.getTotalTime());
    }

    private onTimerCompletion(state: TimerState) {
        // Handled in onTimerComplete
    }
}

class PomodoroSettingTab extends PluginSettingTab {
    plugin: PomodoroPlugin;
    
    constructor(app: App, plugin: PomodoroPlugin) { 
        super(app, plugin); 
        this.plugin = plugin; 
    }
    
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        
        new Setting(containerEl)
            .setName('Work time')
            .setDesc('Duration of focus sessions (minutes)')
            .addSlider(slider => slider
                .setLimits(1, 60, 2)
                .setValue(this.plugin.settings.workTime)
                .setDynamicTooltip()
                .onChange(async (value) => { 
                    this.plugin.settings.workTime = value; 
                    await this.plugin.saveSettings(); 
                }));
        
        new Setting(containerEl)
            .setName('Short break time')
            .setDesc('Duration of short breaks (minutes)')
            .addSlider(slider => slider
                .setLimits(1, 30, 1)
                .setValue(this.plugin.settings.shortBreakTime)
                .setDynamicTooltip()
                .onChange(async (value) => { 
                    this.plugin.settings.shortBreakTime = value; 
                    await this.plugin.saveSettings(); 
                }));
        
        new Setting(containerEl)
            .setName('Long break time')
            .setDesc('Duration of long breaks (minutes)')
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(this.plugin.settings.longBreakTime)
                .setDynamicTooltip()
                .onChange(async (value) => { 
                    this.plugin.settings.longBreakTime = value; 
                    await this.plugin.saveSettings(); 
                }));

        new Setting(containerEl)
            .setName('Sessions until long break')
            .setDesc('Number of focus sessions before a long break')
            .addSlider(slider => slider
                .setLimits(2, 10, 1)
                .setValue(this.plugin.settings.longBreakInterval)
                .setDynamicTooltip()
                .onChange(async (value) => { 
                    this.plugin.settings.longBreakInterval = value; 
                    await this.plugin.saveSettings(); 
                }));

        new Setting(containerEl)
            .setName('Auto-start')
            .setHeading();
        
        new Setting(containerEl)
            .setName('Auto-start breaks')
            .setDesc('Automatically start break sessions')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoStartBreaks)
                .onChange(async (value) => {
                    this.plugin.settings.autoStartBreaks = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto-start focus sessions')
            .setDesc('Automatically start focus sessions after breaks')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoStartPomodoros)
                .onChange(async (value) => {
                    this.plugin.settings.autoStartPomodoros = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Notification')
            .setHeading();

        new Setting(containerEl)
            .setName('Play sound')
            .setDesc('Play a sound when sessions end')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.playSound)
                .onChange(async (value) => {
                    this.plugin.settings.playSound = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Desktop notifications')
            .setDesc('Show desktop notifications when sessions end')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showDesktopNotification)
                .onChange(async (value) => {
                    this.plugin.settings.showDesktopNotification = value;
                    await this.plugin.saveSettings();
                }));
    }
}