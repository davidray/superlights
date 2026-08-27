import { evaluateSchedule, timeInRange, loadConfig } from "./holidaySchedule.js";
import { playSceneLive, stopStream } from "./liveStreamController.js";
import * as actions from "./actions.js";

// Runs inside the always-on trigger server. Every tick: figure out which rule (if
// any) applies today -- overrides beat holiday windows -- and whether we should
// currently be on or off per its onTime/offTime, then fire a transition only when
// that differs from what we last applied. Scenes always refer to custom scenes
// (scenes.ts), streamed live via DDP, not WLED presets/effects -- this scheduler is
// scoped to that one job.

const TICK_MS = 30_000;

interface AppliedState {
  device: string;
  ruleId: string;
  on: boolean;
}

let lastApplied: AppliedState | null = null;

async function applyOn(device: string, scene: string): Promise<void> {
  await playSceneLive(device, scene, {});
}

async function applyOff(device: string): Promise<void> {
  stopStream(device);
  await actions.setPower(device, false);
}

async function tick(): Promise<void> {
  const now = new Date();
  const config = loadConfig();
  const rule = evaluateSchedule(now, config);

  if (!rule) {
    if (lastApplied?.on) {
      await applyOff(lastApplied.device);
    }
    lastApplied = null;
    return;
  }

  const shouldBeOn = timeInRange(now, rule.onTime, rule.offTime);
  const alreadyCorrect =
    lastApplied?.ruleId === rule.id && lastApplied?.device === rule.device && lastApplied?.on === shouldBeOn;
  if (alreadyCorrect) return;

  if (shouldBeOn) {
    console.error(`[scheduler] applying "${rule.name}" (${rule.source}) -> scene "${rule.scene}" on ${rule.device}`);
    await applyOn(rule.device, rule.scene);
  } else {
    console.error(`[scheduler] "${rule.name}" (${rule.source}) off period -> powering off ${rule.device}`);
    await applyOff(rule.device);
  }
  lastApplied = { device: rule.device, ruleId: rule.id, on: shouldBeOn };
}

export function startScheduler(): void {
  void tick().catch((err) => console.error(`[scheduler] tick failed: ${(err as Error).message}`));
  setInterval(() => {
    void tick().catch((err) => console.error(`[scheduler] tick failed: ${(err as Error).message}`));
  }, TICK_MS);
}
