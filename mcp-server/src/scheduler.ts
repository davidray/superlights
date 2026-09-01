import { evaluateSchedule, timeInRange, loadConfig } from "./holidaySchedule.js";
import { playSceneLive, stopStream } from "./liveStreamController.js";
import * as actions from "./actions.js";

// Runs inside the always-on trigger server. Every tick: figure out which rule (if
// any) applies today for each device -- overrides beat holiday windows beat the
// device's default schedule, evaluated per device so devices schedule independently
// (the house and a lamp can both be on at once) -- and whether each should currently
// be on or off per its onTime/offTime, then fire a transition only where that differs
// from what we last applied. Scenes always refer to custom scenes (scenes.ts),
// streamed live via DDP, not WLED presets/effects -- this scheduler is scoped to
// that one job.

const TICK_MS = 30_000;

interface AppliedState {
  ruleId: string;
  on: boolean;
}

const lastApplied = new Map<string, AppliedState>();

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
  const rules = evaluateSchedule(now, config);
  const ruleByDevice = new Map(rules.map((r) => [r.device, r]));

  // A device we previously touched whose rule disappeared entirely (deleted/disabled
  // mid-day) gets turned off -- once -- then forgotten.
  for (const [device, state] of lastApplied) {
    if (ruleByDevice.has(device)) continue;
    if (state.on) {
      await applyOff(device).catch((err) => console.error(`[scheduler] failed to power off ${device}: ${(err as Error).message}`));
    }
    lastApplied.delete(device);
  }

  // One device failing (unplugged lamp, WLED mid-reboot) must not block the others,
  // or leave stale lastApplied state that suppresses a retry: only record the new
  // state once the transition actually succeeded.
  for (const [device, rule] of ruleByDevice) {
    const shouldBeOn = timeInRange(now, rule.onTime, rule.offTime);
    const prev = lastApplied.get(device);
    if (prev?.ruleId === rule.id && prev.on === shouldBeOn) continue;

    try {
      if (shouldBeOn) {
        console.error(`[scheduler] applying "${rule.name}" (${rule.source}) -> scene "${rule.scene}" on ${device}`);
        await applyOn(device, rule.scene);
      } else {
        console.error(`[scheduler] "${rule.name}" (${rule.source}) off period -> powering off ${device}`);
        await applyOff(device);
      }
      lastApplied.set(device, { ruleId: rule.id, on: shouldBeOn });
    } catch (err) {
      console.error(`[scheduler] transition failed for ${device}: ${(err as Error).message}`);
    }
  }
}

export function startScheduler(): void {
  void tick().catch((err) => console.error(`[scheduler] tick failed: ${(err as Error).message}`));
  setInterval(() => {
    void tick().catch((err) => console.error(`[scheduler] tick failed: ${(err as Error).message}`));
  }, TICK_MS);
}
